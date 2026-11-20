import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest


# Run from inside ComfyUI/custom_nodes/comfyQ, or set COMFYUI_PATH to the ComfyUI folder.
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, os.environ.get("COMFYUI_PATH", str(ROOT.parents[1])))
import folder_paths

sys.modules["server"] = types.SimpleNamespace(PromptServer=type("PromptServer", (), {}))
source = ROOT / "server.py"
spec = importlib.util.spec_from_file_location("comfyq_test_server", source)
server = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = server
spec.loader.exec_module(server)


class ModelPathTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=ROOT)
        self.root = Path(self.temp.name)
        self.primary = self.root / "primary"
        self.secondary = self.root / "secondary"
        self.primary.mkdir()
        self.secondary.mkdir()
        folder_paths.folder_names_and_paths["comfyq_test"] = (
            [str(self.primary), str(self.secondary)], {".safetensors"}
        )

    def tearDown(self):
        del folder_paths.folder_names_and_paths["comfyq_test"]
        self.temp.cleanup()

    def test_existing_model_in_second_root(self):
        nested = self.secondary / "nested"
        nested.mkdir()
        (nested / "encoder.safetensors").write_bytes(b"test fixture, not a model")
        self.assertEqual(server._resolve_model_path("comfyq_test", filename="nested/encoder.safetensors"), str(nested))

    def test_virtual_model_opens_root(self):
        self.assertEqual(server._resolve_model_path("comfyq_test", filename="taesd3"), str(self.primary))
        self.assertFalse((self.primary / "taesd3").exists())

    def test_missing_filename_opens_containing_folder(self):
        self.assertEqual(server._resolve_model_path("comfyq_test", filename="nested/missing.safetensors"), str(self.primary / "nested"))

    def test_download_retains_new_subfolder(self):
        self.assertEqual(server._resolve_target_dir("comfyq_test", subfolder="new/nested"), str(self.primary / "new/nested"))

    def test_traversal_is_rejected(self):
        with self.assertRaises(ValueError):
            server._resolve_model_path("comfyq_test", filename="../outside.safetensors")


class OutputTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=ROOT)
        self.previous = folder_paths.get_output_directory()
        folder_paths.set_output_directory(self.temp.name)
        root = Path(self.temp.name)
        (root / "old.png").write_bytes(b"x")
        os.utime(root / "old.png", (1, 1))
        (root / "sub").mkdir()
        (root / "sub" / "new.webp").write_bytes(b"x")
        (root / "notes.txt").write_text("not media")

    def tearDown(self):
        folder_paths.set_output_directory(self.previous)
        self.temp.cleanup()

    def test_lists_media_newest_first(self):
        self.assertEqual([(f["subfolder"], f["filename"]) for f in server._list_outputs()], [("sub", "new.webp"), ("", "old.png")])

    def test_output_file_stays_inside_output(self):
        self.assertEqual(server._output_file("new.webp", "sub"), str(Path(self.temp.name, "sub", "new.webp")))
        with self.assertRaises(ValueError):
            server._output_file("old.png", "../")
        with self.assertRaises(FileNotFoundError):
            server._output_file("missing.png", "")


class FindModelTests(unittest.TestCase):
    def test_queries_drop_precision_suffixes(self):
        self.assertEqual(server._search_queries("z_image_turbo_bf16.safetensors"), ["z_image_turbo_bf16", "z_image_turbo"])
        self.assertEqual(server._search_queries("flux1-dev-fp8_e4m3fn.safetensors"), ["flux1-dev-fp8_e4m3fn", "flux1-dev"])
        self.assertEqual(server._search_queries("qwen_3_4b.safetensors"), ["qwen_3_4b"])

    def test_hf_matches_exact_basename_and_prefers_ungated(self):
        models = [
            {"id": "org/gated", "gated": "manual", "siblings": [{"rfilename": "m.safetensors"}]},
            {"id": "org/near", "siblings": [{"rfilename": "m_fp16.safetensors"}]},
            {"id": "Comfy-Org/open", "gated": False, "siblings": [{"rfilename": "split_files/vae/M.safetensors"}]},
        ]
        found = server._match_hf(models, "m.safetensors")
        self.assertEqual(found["label"], "Comfy-Org/open")
        self.assertFalse(found["gated"])
        self.assertEqual(found["url"], "https://huggingface.co/Comfy-Org/open/resolve/main/split_files/vae/M.safetensors")
        self.assertTrue(server._match_hf(models[:1], "m.safetensors")["gated"])
        self.assertIsNone(server._match_hf(models[1:2], "m.safetensors"))

    def test_civitai_matches_file_name(self):
        items = [{"id": 1, "name": "Juggernaut", "modelVersions": [{"id": 7, "name": "X", "files": [
            {"name": "other.safetensors", "downloadUrl": "https://civitai.com/api/download/models/6"},
            {"name": "juggernautX.safetensors", "downloadUrl": "https://civitai.com/api/download/models/7", "sizeKB": 2.0},
        ]}]}]
        found = server._match_civitai(items, "JuggernautX.safetensors")
        self.assertEqual((found["url"], found["page"], found["size"]), ("https://civitai.com/api/download/models/7", "https://civitai.com/models/1?modelVersionId=7", 2048))
        self.assertIsNone(server._match_civitai(items, "missing.safetensors"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
