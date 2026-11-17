const fs = require("node:fs");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const path = require("node:path");

let extension;
const messages = [];
const ordinary = { type: "VAELoader", isSubgraphNode: () => false };
const subgraph = { type: "uuid", isSubgraphNode: () => true };
const graph = {
  _nodes: [ordinary, subgraph],
  subgraphs: new Map([["uuid", {}]]),
  extra: {},
  remove(node) { this._nodes.splice(this._nodes.indexOf(node), 1); },
  setDirtyCanvas() {}, beforeChange() {}, afterChange() {},
};
const app = {
  graph, canvas: {graph}, ui: {dialog: {show: message => messages.push(message)}},
  registerExtension(value) { extension = value; },
};
const file = path.join(__dirname, "../web/comfyq.js");
const source = fs.readFileSync(file, "utf8").replace(/^import .*;\r?\n/gm, "");
const scope = { app, api: {}, console, Map, URL, URLSearchParams, location: { href: "http://127.0.0.1:8188/" } };
vm.runInNewContext(source, scope);
const remove = extension.getCanvasMenuItems().find(item => item?.content === "comfyQol: Remove All Subgraphs").callback;
remove();
assert.deepEqual(graph._nodes, [ordinary]);
assert.equal(graph.subgraphs.size, 0);
remove();
assert.deepEqual(graph._nodes, [ordinary]);

const node = {type:"DualCLIPLoader",size:[300,100],flags:{},widgets:[
  {name:"clip_name1",y:25,value:"first.safetensors"},
  {name:"clip_name2",y:50,value:"second.safetensors"},
]};
extension.nodeCreated(node);
const ctx = new Proxy({}, {get:()=>()=>{},set:()=>true});
node.onDrawForeground(ctx);
assert.equal(node.__comfyqFolderIconRects.length,2);
for (const rect of node.__comfyqFolderIconRects) {
  assert.equal(rect.folder,"text_encoders");
  assert.ok(rect.x > rect.widget.width - 6, "Icon must be outside the combo click bounds");
}

// Promoted widgets appear after nodeCreated; icons must still be drawn for them.
const promoted = {type:"uuid",size:[300,100],flags:{},widgets:[],isSubgraphNode:()=>true,subgraph:{nodes:[
  {type:"UNETLoader",widgets:[{name:"unet_name",value:"z.safetensors"}]},
  {type:"VAELoader",widgets:[{name:"vae_name",value:"ae.safetensors"}]},
]}};
extension.nodeCreated(promoted);
promoted.widgets.push({name:"unet_name",y:25,value:"z.safetensors"});
promoted.onDrawForeground(ctx);
assert.equal(promoted.__comfyqFolderIconRects.length,1);
assert.equal(promoted.__comfyqFolderIconRects[0].folder,"diffusion_models");
const menu = extension.getNodeMenuItems(promoted);
assert.equal(menu.length,2,"Subgraph node with inner loaders gets model menu items");

// Unpack flattens nested subgraphs and stops on ones that cannot be unpacked.
const inner = {type:"inner", isSubgraphNode:()=>true};
const outer = {type:"outer", isSubgraphNode:()=>true};
const broken = {type:"broken", isSubgraphNode:()=>true};
graph._nodes = [ordinary, outer, broken];
graph.unpackSubgraph = function(node) {
  if (node === broken) return;
  this._nodes.splice(this._nodes.indexOf(node), 1, ...(node === outer ? [inner] : [{type:"KSampler"}]));
};
messages.length = 0;
extension.getCanvasMenuItems().find(item => item?.content === "comfyQol: Unpack All Subgraphs").callback();
assert.deepEqual(graph._nodes.map(n => n.type), ["VAELoader", "KSampler", "broken"]);
assert.match(messages[0], /Unpacked 2 subgraph\(s\); 1 could not/);
// Missing models: value not in the combo list; URL comes from the workflow's properties.models.
const missingLoader = {type:"UNETLoader",properties:{models:[{name:"z.safetensors",directory:"diffusion_models",url:"https://example.test/z.safetensors"}]},
  widgets:[{name:"unet_name",value:"z.safetensors",options:{values:["other.safetensors"]}}]};
const installedLoader = {type:"VAELoader",widgets:[{name:"vae_name",value:"ae.safetensors",options:{values:["ae.safetensors"]}}]};
graph._nodes = [missingLoader, installedLoader];
graph.subgraphs = new Map();
const missingMenu = extension.getNodeMenuItems(missingLoader).map(i => i.content);
assert.ok(missingMenu.includes("comfyQol: Download Missing Model (1)"), missingMenu.join());
assert.ok(extension.getNodeMenuItems(installedLoader).map(i => i.content).includes("comfyQol: Download Model Here"));
extension.nodeCreated(missingLoader);
missingLoader.size = [300,100]; missingLoader.flags = {}; missingLoader.widgets[0].y = 25;
missingLoader.onDrawForeground(ctx);
assert.equal(missingLoader.__comfyqFolderIconRects.map(r => r.action).join(), "open,download");

// Dashboard: widgets grouped by section, prompts labelled by the sampler input they feed, bypassed nodes and linked widgets skipped.
const links = new Map();
const link = (id, from, to, slot) => { links.set(id, {target_id: to.id, target_slot: slot}); from.outputs[0].links.push(id); };
const dashGraph = {links, getNodeById: id => dashGraph._nodes.find(n => n.id === id) || subNodes.find(n => n.id === id)};
const sampler = {id: 3, type: "KSampler", title: "KSampler", graph: dashGraph, inputs: [{name: "positive"}, {name: "negative"}],
  widgets: [{name: "seed", value: 1}, {name: "control_after_generate", value: "fixed"}, {name: "steps", value: 20}, {name: "cfg", value: 7},
    {name: "sampler_name", value: "euler", options: {values: ["euler"]}}, {name: "denoise", value: 1}]};
const guidance = {id: 4, type: "FluxGuidance", title: "Guidance", graph: dashGraph, inputs: [{name: "conditioning"}], outputs: [{links: []}], widgets: [{name: "guidance", value: 3.5}]};
const positive = {id: 1, type: "CLIPTextEncode", title: "Text", graph: dashGraph, outputs: [{links: []}], widgets: [{name: "text", value: "a cat"}]};
const negative = {id: 2, type: "CLIPTextEncode", title: "Text", graph: dashGraph, outputs: [{links: []}], widgets: [{name: "text", value: "blurry"}]};
const latent = {id: 5, type: "EmptyLatentImage", title: "Latent", graph: dashGraph, inputs: [{name: "width", widget: {name: "width"}, link: 9}],
  widgets: [{name: "width", value: 1024}, {name: "height", value: 1024}, {name: "batch_size", value: 1}]};
const save = {id: 6, type: "SaveImage", title: "Save", graph: dashGraph, constructor: {nodeData: {output_node: true}}, widgets: [{name: "filename_prefix", value: "ComfyUI"}]};
const bypassed = {id: 7, type: "LoraLoader", title: "Off", mode: 4, graph: dashGraph, widgets: [{name: "lora_name", value: "x.safetensors"}]};
const subNodes = [{id: 8, type: "CheckpointLoaderSimple", title: "Load Checkpoint", widgets: [{name: "ckpt_name", value: "m.safetensors"}]}];
const sub = {id: 9, type: "uuid", title: "Model", isSubgraphNode: () => true, subgraph: {nodes: subNodes}};
link(1, negative, guidance, 0);
links.set(2, {target_id: 3, target_slot: 1}); guidance.outputs[0].links.push(2);
link(3, positive, sampler, 0);
dashGraph._nodes = [negative, positive, guidance, sampler, latent, save, bypassed, sub];
app.graph = dashGraph;
const sections = Object.fromEntries(scope.dashboardGroups().map(([name, groups]) => [name, groups.map(g => `${g.role || ""}:${g.title}:${g.widgets.map(w => w.name).join("+")}`)]));
assert.equal(JSON.stringify(sections), JSON.stringify({
  Prompt: ["Positive:Text:text", "Negative:Text:text"],
  Models: [":Model › Load Checkpoint:ckpt_name"],
  Sampling: [":Guidance:guidance", ":KSampler:steps+cfg+sampler_name"],
  Generation: [":KSampler:seed+control_after_generate", ":Latent:height+batch_size"],
  Refinement: [":KSampler:denoise"],
  Output: [":Save:filename_prefix"],
}));

// Saving uses the original file named in a /view URL, not the preview parameters.
assert.equal(JSON.stringify(scope.fileFromViewUrl("/api/view?filename=a.png&subfolder=x&type=temp&preview=webp;50&rand=1")),
  JSON.stringify({filename: "a.png", subfolder: "x", type: "temp"}));
assert.equal(scope.fileFromViewUrl("/assets/logo.png"), null);
console.log("PASS: ordinary nodes preserved, subgraphs removed, repeat removal safe, dual CLIP icons outside combo bounds, promoted/nested subgraph models, unpack, missing-model detection, dashboard sections, view URL parsing.");
