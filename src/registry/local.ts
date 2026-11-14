/**
 * Models that run on the operator's own machine instead of the treg gateway. They are free:
 * no catalog price row exists for them, so they quote $0. The server only runs them when
 * their backend is configured (see `src/server/providers`).
 */
import { aspect, compact, opt, resolution, text } from "./helpers";
import type { ModelDef } from "./types";

export const COMFYUI_ENDPOINT_ID = "comfyui.image";

/** Endpoint ids the worker runs on a local backend instead of sending to the treg gateway. */
export const isLocalEndpoint = (endpoint: string) => endpoint.startsWith("comfyui.");

export const localModels: ModelDef[] = [
  {
    id: "comfyui",
    kind: "image",
    name: "ComfyUI",
    vendor: "Local",
    tagline: "Your own ComfyUI server. Free, runs on your GPU.",
    badges: ["Free", "Local"],
    status: "available",
    surfaces: ["image"],
    prompt: { required: true, maxLength: 2000, placeholder: "Describe the image: subject, setting, light, mood." },
    slots: [{ id: "refs", label: "Reference", hint: "Add one image to restyle it (image to image).", accept: ["image"], min: 0, max: 1 }],
    controls: [
      aspect(["1:1", "16:9", "9:16", "4:3", "3:4"], "1:1"),
      resolution([opt("512"), opt("768"), opt("1024")], "512", "Size"),
      text("negative", "Negative prompt", 1000, { advanced: true, placeholder: "What to keep out of the picture." }),
      text("checkpoint", "Checkpoint", 200, { advanced: true, placeholder: "Empty uses the server's first checkpoint", hint: "File name of a checkpoint in ComfyUI's models/checkpoints folder." }),
    ],
    batch: { max: 4, native: false },
    output: "image",
    eta: 20,
    build({ prompt, values, media }) {
      const ref = media.refs?.[0];
      return {
        endpoint: COMFYUI_ENDPOINT_ID,
        body: compact({
          prompt,
          negative: values.negative || undefined,
          checkpoint: values.checkpoint || undefined,
          aspect: values.aspect,
          size: values.resolution,
          // The worker swaps the placeholder for the file's bytes in base64 just before sending.
          reference: ref?.data,
          mime: ref?.mime,
        }),
      };
    },
  },
];
