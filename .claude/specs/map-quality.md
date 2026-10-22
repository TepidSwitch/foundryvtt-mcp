# Spec: Map quality (ComfyUI battlemap generation)

Status: IMPLEMENTED in 08dea03 (steps 1 to 4). Live verification NOT yet run; the
composition and memory claims below are unverified. Docs (step 5) and sketch
img2img (step 6) are pending.
Date: 2026-10-21 (updated 2026-10-22)

## Context

`foundry_generate_edit map` renders one SDXL image in ComfyUI and imports it as an
inactive scene. First live test (2026-10-19, RTX 3060 12 GB): works, 1536x1536 at
`low` (8 steps) took about 40 s, but the result read as a tavern building in the
middle of a dark yard, not a courtyard.

Facts used here:

- The workflow already matches the model author's settings: CFG 2.5, `dpmpp_2m_sde`,
  Karras ([Civitai page](https://civitai.com/models/1073005)). The author recommends
  30 steps at 1024x1024, then a 2x upscale at about 0.5 denoise for detail.
- `src/generate/comfyui.ts` renders directly at the final size (small 1024, medium
  1536, large 2048). SDXL is trained at about 1024, so larger direct renders tend to
  repeat or fragment composition. This is the most likely cause of the odd layout
  (inference, not yet tested).
- ComfyUI on the PC has every node needed: `LatentUpscaleBy`, `VAEDecodeTiled`,
  `VAEEncode`, `LoadImage`, `ImageScaleBy`, `UpscaleModelLoader`,
  `ImageUpscaleWithModel`. No upscale model file is installed.
- Free RAM was 5.1 GB of 15.9 GB when ComfyUI was last restarted, and ComfyUI was
  killed once for memory. Any change must not raise peak memory.

## Goals

1. Better composition and detail without the user doing anything: render at the
   model's native size, then upscale.
2. Cheap iteration: try prompts without creating Foundry scenes and uploads.
3. A few controls the model author says matter (CFG, extra negative terms).

Out of scope: regional prompting and inpainting (need custom nodes), grid alignment
(`fit_grid` exists), hosted ComfyUI (already supported by `COMFYUI_API_KEY`).

## Requirements and scenarios

R1 Two-pass render for sizes above 1024
- Given `size` medium (1536) or large (2048)
- When a map job starts
- Then pass 1 renders at 1024 (aspect kept, sides multiple of 64), the latent is
  upscaled to the target size, pass 2 runs at denoise 0.5, and the image is decoded
  with `VAEDecodeTiled`.
- Given `size` small (1024) Then the workflow is unchanged (single pass).

R2 Quality maps to steps for both passes
- `low` 8 / `medium` 20 / `high` 35 for pass 1; pass 2 uses about half (min 6).
- Given no `quality` Then the default is `medium` (was `low`). *(open question 1)*

R3 CFG and extra negative terms
- Given `cfg` (1 to 4) Then it replaces 2.5 in both passes.
- Given `avoid` (string) Then it is appended to the built-in negative prompt.
- Tool description tells the caller: describe terrain and features as tags; naming a
  building can make the model draw it.

R4 Render-only mode
- Given `create_scene: false`
- Then the image is saved to the ComfyUI output folder, the job reports its file
  name and path, and nothing is uploaded to or created in Foundry.
- `map_status` shows the path; a later call can import it (see R5).

R5 Import an existing image (small)
- Given `import_image` (local path) Then it skips ComfyUI and creates the scene from
  that file, using the existing upload path. Lets a good draft be kept without
  re-rendering. *(optional, open question 3)*

R6 Sketch to map (img2img) — later phase
- Given `sketch_path` (local PNG) Then it is uploaded to ComfyUI, encoded with
  `VAEEncode`, and run at denoise 0.75 in place of the empty latent.

## Interface contract (additions to `foundry_generate_edit map`)

| Field | Type | Default | Notes |
|---|---|---|---|
| `cfg` | number 1 to 4 | 2.5 | lower (2) for lava or snow |
| `avoid` | string | none | appended to the negative prompt |
| `create_scene` | boolean | true | false = render only |
| `quality` | low / medium / high | medium | default changes |
| `sketch_path` | string | none | phase 3 |

No existing field changes meaning, except the `quality` default.

## Implementation plan (atomic commits, tests with each)

1. `refactor(generate): split buildWorkflow into pass builders` — no behaviour change;
   tests pin the current node graph first.
2. `feat(generate): render at 1024 then upscale to the target size` — R1, R2,
   `VAEDecodeTiled`; tests assert node types, links, denoise and pass-1 dimensions.
3. `feat(generate): cfg and avoid parameters` — R3; schema, handler, tool description.
4. `feat(generate): render-only mode` — R4; job state gets `imagePath`; skips import.
5. `docs: map quality guide` — fork-setup.md and the handoff doc (quality table,
   prompt tips, VRAM and RAM notes).
6. (later) `feat(generate): sketch img2img` — R6.

## Live verification (on the Windows PC, same seed and prompt each time)

| Run | Check |
|---|---|
| Baseline: 1536 single pass, low | already seen (tavern building in a yard) |
| New: 1536 two pass, medium | composition, time, peak VRAM via `nvidia-smi` |
| New: 2048 two pass, high | completes without out-of-memory; time |
| Render-only | no scene or file appears in Foundry; path returned |

Pass criteria: no out-of-memory on 12 GB at 2048; 1536 medium under about 3 minutes;
a human judges composition better than baseline on at least 3 of 4 prompts.

## Risks

- Peak RAM when ComfyUI loads the 6.9 GB checkpoint with 5 GB free. Mitigation: tiled
  decode, and say in the guide to close other apps first.
- Pass 2 at denoise 0.5 can repaint features. Mitigation: expose nothing yet; tune
  with the live runs, and adjust the constant.
- Changing the default quality makes jobs slower for existing callers. Mitigation:
  documented; `quality: low` still gives the quick draft.

## Decisions (2026-10-22)

1. Default quality: `medium`. Done.
2. Render-only mode: built now (R4). Done.
3. Import a kept draft (R5): built as `import_map`. Done.
4. Sketch img2img (R6): later.
5. ESRGAN upscale model: not now.

## Implementation notes

- Steps 1 to 3 landed as a single commit with step 4. The base pass keeps the old
  node ids ('1' to '5', '9'); the second pass adds '10' (`LatentUpscale`, exact
  size, not a scale factor, so sides stay multiples of 64) and '11' (`KSampler`).
- `VAEDecodeTiled` is sent with `tile_size` and `overlap` only. ComfyUI 0.42.1
  accepting that is unverified.

## Still to verify (live, later)

Run the table above, render-only so no scenes are created. Record time, peak VRAM
and whether 2048 completes, then fill in the docs step.
