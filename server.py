from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import re
import shutil
import subprocess
import sys
import time
import uuid
from dataclasses import dataclass, field
from email.message import Message
from pathlib import PurePath
from typing import Any
from io import BytesIO
from urllib.parse import unquote, urlparse

import aiohttp
from aiohttp import web

import folder_paths
from PIL import Image
from server import PromptServer

if sys.platform.startswith("win"):
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    user32.EnumWindows.argtypes = [WNDENUMPROC, wintypes.LPARAM]
    user32.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user32.IsWindowVisible.argtypes = [wintypes.HWND]
    user32.GetForegroundWindow.restype = wintypes.HWND
    user32.MonitorFromWindow.argtypes = [wintypes.HWND, wintypes.DWORD]
    user32.MonitorFromWindow.restype = wintypes.HMONITOR
    user32.GetMonitorInfoW.argtypes = [wintypes.HMONITOR, ctypes.c_void_p]
    user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
    user32.SetWindowPos.argtypes = [wintypes.HWND, wintypes.HWND, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, wintypes.UINT]
    user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
    user32.BringWindowToTop.argtypes = [wintypes.HWND]
    user32.SetForegroundWindow.argtypes = [wintypes.HWND]
    user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user32.GetWindowThreadProcessId.restype = wintypes.DWORD
    user32.AttachThreadInput.argtypes = [wintypes.DWORD, wintypes.DWORD, wintypes.BOOL]
    user32.SetThreadDpiAwarenessContext.argtypes = [ctypes.c_void_p]
    user32.SetThreadDpiAwarenessContext.restype = ctypes.c_void_p

    class MONITORINFO(ctypes.Structure):
        _fields_ = [("cbSize", wintypes.DWORD), ("rcMonitor", wintypes.RECT), ("rcWork", wintypes.RECT), ("dwFlags", wintypes.DWORD)]

    SW_RESTORE = 9
    MONITOR_DEFAULTTONEAREST = 2
    SWP_NOZORDER = 0x0004
    SWP_NOACTIVATE = 0x0010
    VK_MENU = 0x12
    KEYEVENTF_KEYUP = 0x0002
    DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4


DOWNLOADS: dict[str, "DownloadJob"] = {}
EXTRA_MODEL_EXTENSIONS = {
    ".gguf",
    ".onnx",
    ".json",
    ".yaml",
    ".yml",
    ".txt",
}


@dataclass
class DownloadJob:
    id: str
    url: str
    folder: str
    destination: str
    status: str = "queued"
    bytes_downloaded: int = 0
    total_bytes: int | None = None
    started_at: float = field(default_factory=time.time)
    finished_at: float | None = None
    error: str | None = None

    def to_json(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "url": self.url,
            "folder": self.folder,
            "destination": self.destination,
            "filename": os.path.basename(self.destination),
            "status": self.status,
            "bytes_downloaded": self.bytes_downloaded,
            "total_bytes": self.total_bytes,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "error": self.error,
        }


def _json_error(message: str, status: int = 400) -> web.Response:
    return web.json_response({"error": message}, status=status)


def _normal_folder_name(folder: str) -> str:
    if not isinstance(folder, str) or not folder:
        raise ValueError("folder is required")
    mapped = folder_paths.map_legacy(folder)
    if mapped not in folder_paths.folder_names_and_paths:
        raise ValueError(f"Unknown model folder: {folder}")
    return mapped


def _safe_subpath(value: str | None) -> str:
    if not value:
        return ""
    normalized = value.replace("\\", "/").strip("/")
    path = PurePath(normalized)
    if path.is_absolute() or any(part in {"..", ""} for part in path.parts):
        raise ValueError("Subfolders cannot be absolute or contain '..'")
    return os.path.join(*path.parts) if path.parts else ""


def _safe_filename(value: str) -> str:
    name = os.path.basename(value.replace("\\", "/")).strip()
    if not name or name in {".", ".."}:
        raise ValueError("A filename could not be determined")
    if any(ch in name for ch in '<>:"|?*\0'):
        raise ValueError(f"Invalid filename: {name}")
    return name


def _filename_from_headers_or_url(headers: Message | aiohttp.typedefs.LooseHeaders, url: str) -> str:
    disposition = headers.get("Content-Disposition") if headers else None
    if disposition:
        match = re.search(r"filename\*=UTF-8''([^;]+)|filename=\"?([^\";]+)\"?", disposition)
        if match:
            return _safe_filename(unquote(match.group(1) or match.group(2)))

    parsed = urlparse(url)
    return _safe_filename(unquote(os.path.basename(parsed.path)))


def _allowed_extensions(folder: str) -> set[str]:
    exts = folder_paths.folder_names_and_paths[folder][1]
    if isinstance(exts, set):
        return {x.lower() for x in exts if x and x != "folder"} | EXTRA_MODEL_EXTENSIONS
    return {str(x).lower() for x in exts if x and x != "folder"} | EXTRA_MODEL_EXTENSIONS


def _validate_download_extension(folder: str, filename: str) -> None:
    ext = os.path.splitext(filename)[1].lower()
    allowed = _allowed_extensions(folder)
    if allowed and ext not in allowed:
        raise ValueError(
            f"{filename} does not look like a supported model file for '{folder}'. "
            f"Allowed extensions include: {', '.join(sorted(allowed))}"
        )


def _folder_root(folder: str, path_index: int = 0) -> str:
    folder = _normal_folder_name(folder)
    roots = folder_paths.folder_names_and_paths[folder][0]
    if path_index < 0 or path_index >= len(roots):
        raise ValueError(f"path_index {path_index} is out of range for {folder}")
    return os.path.abspath(roots[path_index])


def _resolve_target_dir(folder: str, path_index: int = 0, subfolder: str | None = None) -> str:
    root = _folder_root(folder, path_index)
    target = os.path.abspath(os.path.join(root, _safe_subpath(subfolder)))
    if os.path.commonpath([root, target]) != root:
        raise ValueError("Resolved target folder escapes the model root")
    return target


def _resolve_model_path(folder: str, path_index: int = 0, filename: str | None = None) -> str:
    root = _folder_root(folder, path_index)
    if not filename:
        return root
    existing = folder_paths.get_full_path(_normal_folder_name(folder), filename)
    if existing and os.path.isfile(existing):
        return os.path.dirname(os.path.abspath(existing))
    relative = _safe_subpath(filename)
    target = os.path.abspath(os.path.join(root, relative))
    if os.path.commonpath([root, target]) != root:
        raise ValueError("Resolved model path escapes the model root")
    ext = os.path.splitext(target)[1].lower()
    model_exts = _allowed_extensions(folder)
    if os.path.isfile(target) or ext in model_exts:
        return os.path.dirname(target)
    return target if os.path.isdir(target) else root


def _explorer_windows() -> dict[int, str]:
    windows: dict[int, str] = {}

    @WNDENUMPROC
    def visit(hwnd, _):
        name = ctypes.create_unicode_buffer(64)
        user32.GetClassNameW(hwnd, name, 64)
        if name.value == "CabinetWClass" and user32.IsWindowVisible(hwnd):
            title = ctypes.create_unicode_buffer(1024)
            user32.GetWindowTextW(hwnd, title, 1024)
            windows[hwnd] = title.value
        return True

    user32.EnumWindows(visit, 0)
    return windows


def _wait_for_explorer_window(path: str, before: dict[int, str]) -> int | None:
    # Prefer the window this call opened; fall back to an existing window showing the folder.
    titles = {os.path.basename(path.rstrip("\\/")), path}
    start = time.monotonic()
    while time.monotonic() - start < 5:
        windows = _explorer_windows()
        new = [hwnd for hwnd in windows if hwnd not in before]
        if new:
            return new[0]
        if time.monotonic() - start > 2:
            match = next((hwnd for hwnd, title in windows.items() if title in titles), None)
            if match:
                return match
        time.sleep(0.1)
    return None


def _show_on_monitor_of(hwnd: int, anchor: int | None) -> None:
    # Explorer started by a background process opens behind the browser and on the primary
    # monitor. Center it on the monitor of the window the user clicked in and bring it forward.
    info = MONITORINFO(cbSize=ctypes.sizeof(MONITORINFO))
    if anchor and user32.GetMonitorInfoW(user32.MonitorFromWindow(anchor, MONITOR_DEFAULTTONEAREST), ctypes.byref(info)):
        rect = wintypes.RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(rect))
        work = info.rcWork
        width = min(rect.right - rect.left, work.right - work.left)
        height = min(rect.bottom - rect.top, work.bottom - work.top)
        left = work.left + (work.right - work.left - width) // 2
        top = work.top + (work.bottom - work.top - height) // 2
        user32.SetWindowPos(hwnd, None, left, top, width, height, SWP_NOZORDER | SWP_NOACTIVATE)

    user32.ShowWindow(hwnd, SW_RESTORE)
    foreground_thread = user32.GetWindowThreadProcessId(user32.GetForegroundWindow(), None)
    this_thread = kernel32.GetCurrentThreadId()
    attached = foreground_thread and foreground_thread != this_thread and user32.AttachThreadInput(this_thread, foreground_thread, True)
    user32.BringWindowToTop(hwnd)
    user32.SetForegroundWindow(hwnd)
    if attached:
        user32.AttachThreadInput(this_thread, foreground_thread, False)
    if user32.GetForegroundWindow() != hwnd:
        # A synthetic Alt press lifts Windows' foreground lock for the next SetForegroundWindow.
        user32.keybd_event(VK_MENU, 0, 0, 0)
        user32.keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, 0)
        user32.SetForegroundWindow(hwnd)


def _open_folder_windows(path: str) -> None:
    previous_dpi = user32.SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)
    try:
        anchor = user32.GetForegroundWindow()
        before = _explorer_windows()
        subprocess.Popen(["explorer.exe", os.path.normpath(path)])
        hwnd = _wait_for_explorer_window(path, before)
        if hwnd:
            _show_on_monitor_of(hwnd, anchor)
    finally:
        if previous_dpi:
            user32.SetThreadDpiAwarenessContext(previous_dpi)


def _open_folder(path: str) -> None:
    os.makedirs(path, exist_ok=True)
    if sys.platform.startswith("win"):
        _open_folder_windows(path)
    elif sys.platform == "darwin":
        subprocess.Popen(["open", path])
    else:
        subprocess.Popen(["xdg-open", path])


def _clear_model_caches(folder: str) -> None:
    folder_paths.filename_list_cache.pop(folder, None)
    instance = getattr(PromptServer, "instance", None)
    manager = getattr(instance, "model_file_manager", None)
    if manager is not None:
        manager.clear_cache()


OUTPUT_MEDIA = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp4", ".webm", ".mov"}
THUMB_SIZE = 320


def _list_outputs() -> list[dict[str, Any]]:
    root = folder_paths.get_output_directory()
    files = []
    for folder, _, names in os.walk(root):
        for name in names:
            if os.path.splitext(name)[1].lower() not in OUTPUT_MEDIA:
                continue
            stat = os.stat(os.path.join(folder, name))
            subfolder = os.path.relpath(folder, root).replace(os.sep, "/")
            files.append({"filename": name, "subfolder": "" if subfolder == "." else subfolder, "type": "output", "mtime": stat.st_mtime, "size": stat.st_size})
    files.sort(key=lambda item: item["mtime"], reverse=True)
    return files


def _output_file(filename: str, subfolder: str) -> str:
    root = os.path.abspath(folder_paths.get_output_directory())
    path = os.path.abspath(os.path.join(root, _safe_subpath(subfolder), _safe_filename(filename)))
    if os.path.commonpath([root, path]) != root or not os.path.isfile(path):
        raise FileNotFoundError("Output file not found")
    return path


def _thumbnail(path: str) -> bytes:
    with Image.open(path) as image:
        image.thumbnail((THUMB_SIZE, THUMB_SIZE))
        if image.mode not in {"RGB", "RGBA"}:
            image = image.convert("RGBA")
        data = BytesIO()
        image.save(data, "WEBP", quality=80)
    return data.getvalue()


def _model_folders_payload() -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    for name, (folders, extensions) in folder_paths.folder_names_and_paths.items():
        if name in {"configs", "custom_nodes"}:
            continue
        output.append(
            {
                "name": name,
                "folders": [os.path.abspath(path) for path in folders],
                "extensions": sorted([str(ext) for ext in extensions]),
            }
        )
    return output


async def _download(job: DownloadJob, expected_sha256: str | None, overwrite: bool) -> None:
    temp_path = job.destination + ".part"
    job.status = "downloading"
    hasher = hashlib.sha256() if expected_sha256 else None
    try:
        os.makedirs(os.path.dirname(job.destination), exist_ok=True)
        if os.path.exists(job.destination) and not overwrite:
            raise FileExistsError(f"{job.destination} already exists")
        if os.path.exists(temp_path):
            os.remove(temp_path)

        timeout = aiohttp.ClientTimeout(total=None, sock_connect=45, sock_read=120)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(job.url, allow_redirects=True) as response:
                if response.status in {401, 403}:
                    raise PermissionError(f"The site refused the download (HTTP {response.status}); it needs a login or API key. Download it in your browser instead: {job.url}")
                response.raise_for_status()
                # aiohttp decompresses HTTP content; its wire length then differs from saved bytes.
                job.total_bytes = response.content_length if response.headers.get("Content-Encoding", "identity").lower() == "identity" else None
                with open(temp_path, "wb") as output:
                    async for chunk in response.content.iter_chunked(1024 * 1024):
                        if not chunk:
                            continue
                        output.write(chunk)
                        job.bytes_downloaded += len(chunk)
                        if hasher is not None:
                            hasher.update(chunk)

        if hasher is not None:
            digest = hasher.hexdigest().lower()
            if digest != expected_sha256.lower():
                raise ValueError(f"SHA256 mismatch: expected {expected_sha256}, got {digest}")

        if overwrite and os.path.exists(job.destination):
            os.remove(job.destination)
        shutil.move(temp_path, job.destination)
        job.status = "complete"
        _clear_model_caches(job.folder)
    except Exception as exc:
        job.status = "error"
        job.error = str(exc)
        try:
            if os.path.exists(temp_path):
                os.remove(temp_path)
        except OSError:
            pass
        logging.exception("[comfyQol] Model download failed")
    finally:
        job.finished_at = time.time()


HF_MODELS_API = "https://huggingface.co/api/models"
CIVITAI_MODELS_API = "https://civitai.com/api/v1/models"
SEARCH_HEADERS = {"User-Agent": "comfyQol"}
COMFY_ORG_TTL = 3600
# Too common to identify one model by name alone.
GENERIC_STEMS = {"model", "pytorch_model", "diffusion_pytorch_model", "ae", "vae", "clip", "unet"}
PRECISION_SUFFIX = re.compile(r"[_\-.](fp16|bf16|fp32|f16|f32|fp8\w*|fp4\w*|nf4|int8|q\d\w*|pruned\w*|ema\w*|scaled)$", re.IGNORECASE)
_search_lock = asyncio.Lock()
_last_search_request = 0.0
_comfy_org_index: tuple[float, list[dict[str, Any]]] | None = None


def _search_queries(filename: str) -> list[str]:
    stem = os.path.splitext(filename)[0]
    queries = [stem]
    trimmed = stem
    while (shorter := PRECISION_SUFFIX.sub("", trimmed)) != trimmed:
        trimmed = shorter
    if trimmed and trimmed != stem:
        queries.append(trimmed)
    return queries


def _match_hf(models: list[dict[str, Any]], filename: str) -> dict[str, Any] | None:
    wanted = filename.lower()
    gated = None
    for model in models:
        for sibling in model.get("siblings") or []:
            path = sibling.get("rfilename", "")
            if path.rsplit("/", 1)[-1].lower() != wanted:
                continue
            result = {
                "found": True,
                "source": "Hugging Face",
                "label": model["id"],
                "url": f"https://huggingface.co/{model['id']}/resolve/main/{path}",
                "page": f"https://huggingface.co/{model['id']}",
                "gated": bool(model.get("gated")),
                "size": None,
            }
            if not result["gated"]:
                return result
            gated = gated or result
    return gated


def _match_civitai(items: list[dict[str, Any]], filename: str) -> dict[str, Any] | None:
    wanted = filename.lower()
    for item in items:
        for version in item.get("modelVersions") or []:
            for file in version.get("files") or []:
                if file.get("name", "").lower() == wanted and file.get("downloadUrl"):
                    return {
                        "found": True,
                        "source": "Civitai",
                        "label": f"{item.get('name', '')} · {version.get('name', '')}",
                        "url": file["downloadUrl"],
                        "page": f"https://civitai.com/models/{item['id']}?modelVersionId={version['id']}",
                        "gated": False,
                        "size": int(file["sizeKB"] * 1024) if file.get("sizeKB") else None,
                    }
    return None


async def _get_json(session: aiohttp.ClientSession, url: str, params: dict[str, str]) -> Any:
    # One request at a time, at least a second apart, so a search never bursts either site.
    global _last_search_request
    async with _search_lock:
        wait = _last_search_request + 1.0 - time.monotonic()
        if wait > 0:
            await asyncio.sleep(wait)
        try:
            async with session.get(url, params=params, headers=SEARCH_HEADERS) as response:
                response.raise_for_status()
                return await response.json()
        finally:
            _last_search_request = time.monotonic()


async def _comfy_org_models(session: aiohttp.ClientSession) -> list[dict[str, Any]]:
    global _comfy_org_index
    if _comfy_org_index is None or time.monotonic() - _comfy_org_index[0] > COMFY_ORG_TTL:
        models = await _get_json(session, HF_MODELS_API, {"author": "Comfy-Org", "full": "true", "limit": "1000"})
        _comfy_org_index = (time.monotonic(), models)
    return _comfy_org_index[1]


async def _find_model(filename: str) -> dict[str, Any]:
    if os.path.splitext(filename)[0].lower() in GENERIC_STEMS:
        return {"found": False, "message": f"{filename} is too generic a name to search for; paste a URL instead."}
    queries = _search_queries(filename)
    errors = []
    gated = None
    timeout = aiohttp.ClientTimeout(total=30)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        try:
            # Comfy-Org repackages most files that ComfyUI templates use, so check its repos first.
            match = _match_hf(await _comfy_org_models(session), filename)
            for query in queries:
                if match and not match["gated"]:
                    return match
                gated = gated or match
                match = _match_hf(await _get_json(session, HF_MODELS_API, {"search": query, "full": "true", "limit": "20", "sort": "downloads"}), filename)
            if match and not match["gated"]:
                return match
            gated = gated or match
        except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
            errors.append(f"Hugging Face: {str(exc) or type(exc).__name__}")

        # Civitai filenames usually start with the model's name, e.g. juggernautXL_v9.safetensors.
        prefix = queries[-1].split("_")[0]
        civitai_queries = queries + ([prefix] if len(prefix) >= 4 and prefix not in queries else [])
        try:
            for query in civitai_queries:
                data = await _get_json(session, CIVITAI_MODELS_API, {"query": query, "limit": "20"})
                found = _match_civitai(data.get("items") or [], filename)
                if found:
                    return found
        except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
            errors.append(f"Civitai: {str(exc) or type(exc).__name__}")

    if gated:
        return gated
    message = f"{filename} was not found on Hugging Face or Civitai."
    if errors:
        message += " Search errors: " + "; ".join(errors)
    return {"found": False, "message": message}


def register_routes() -> None:
    routes = PromptServer.instance.routes

    @routes.get("/comfyq/info")
    async def info(request: web.Request) -> web.Response:
        return web.json_response(
            {
                "version": "1.0.6",
                "process_id": os.getpid(),
                "model_folders": _model_folders_payload(),
                "paths": {
                    "input": folder_paths.get_input_directory(),
                    "output": folder_paths.get_output_directory(),
                    "temp": folder_paths.get_temp_directory(),
                    "custom_nodes": folder_paths.get_folder_paths("custom_nodes"),
                },
                "suggestions": [
                    "Open input, output, custom nodes, and model folders from the UI.",
                    "Download missing models, searching Hugging Face and Civitai when the workflow has no link.",
                    "Unpack or remove all current-workflow subgraphs.",
                    "Copy selected model names and rescan model lists after downloads.",
                ],
            }
        )

    @routes.post("/comfyq/open-folder")
    async def open_folder(request: web.Request) -> web.Response:
        try:
            data = await request.json()
            special = data.get("special")
            if special == "input":
                path = folder_paths.get_input_directory()
            elif special == "output":
                path = folder_paths.get_output_directory()
            elif special == "temp":
                path = folder_paths.get_temp_directory()
            elif special == "custom_nodes":
                path = folder_paths.get_folder_paths("custom_nodes")[0]
            else:
                path = _resolve_model_path(
                    data.get("folder"),
                    int(data.get("path_index", 0)),
                    data.get("filename"),
                )
            await asyncio.to_thread(_open_folder, path)
            return web.json_response({"ok": True, "path": path})
        except Exception as exc:
            return _json_error(str(exc))

    @routes.get("/comfyq/outputs")
    async def list_outputs(request: web.Request) -> web.Response:
        limit = int(request.query.get("limit", 120))
        files = await asyncio.to_thread(_list_outputs)
        return web.json_response({"total": len(files), "files": files[:limit]})

    @routes.get("/comfyq/thumb")
    async def output_thumbnail(request: web.Request) -> web.Response:
        try:
            path = _output_file(request.query.get("filename", ""), request.query.get("subfolder", ""))
            data = await asyncio.to_thread(_thumbnail, path)
        except (OSError, ValueError) as exc:
            return _json_error(str(exc), status=404)
        return web.Response(body=data, content_type="image/webp", headers={"Cache-Control": "max-age=86400"})

    @routes.get("/comfyq/find-model")
    async def find_model(request: web.Request) -> web.Response:
        try:
            filename = _safe_filename(request.query.get("filename", ""))
        except ValueError as exc:
            return _json_error(str(exc))
        return web.json_response(await _find_model(filename))

    @routes.get("/comfyq/downloads")
    async def list_downloads(request: web.Request) -> web.Response:
        return web.json_response([job.to_json() for job in DOWNLOADS.values()])

    @routes.get("/comfyq/downloads/{job_id}")
    async def get_download(request: web.Request) -> web.Response:
        job = DOWNLOADS.get(request.match_info["job_id"])
        if job is None:
            return _json_error("Unknown download id", status=404)
        return web.json_response(job.to_json())

    @routes.post("/comfyq/download")
    async def start_download(request: web.Request) -> web.Response:
        try:
            data = await request.json()
            url = str(data.get("url", "")).strip()
            parsed = urlparse(url)
            if parsed.scheme not in {"http", "https"}:
                raise ValueError("Download URL must start with http:// or https://")

            folder = _normal_folder_name(data.get("folder"))
            path_index = int(data.get("path_index", 0))
            target_dir = _resolve_target_dir(folder, path_index, data.get("subfolder"))
            filename = data.get("filename")
            if filename:
                filename = _safe_filename(filename)
            else:
                filename = _filename_from_headers_or_url({}, url)
            _validate_download_extension(folder, filename)

            destination = os.path.abspath(os.path.join(target_dir, filename))
            if os.path.commonpath([target_dir, destination]) != target_dir:
                raise ValueError("Resolved destination escapes target folder")

            job_id = uuid.uuid4().hex
            job = DownloadJob(job_id, url, folder, destination)
            DOWNLOADS[job_id] = job
            task = asyncio.create_task(
                _download(
                    job,
                    data.get("sha256") or None,
                    bool(data.get("overwrite", False)),
                )
            )
            task.add_done_callback(lambda done: done.exception() if not done.cancelled() else None)
            return web.json_response(job.to_json())
        except Exception as exc:
            return _json_error(str(exc))
