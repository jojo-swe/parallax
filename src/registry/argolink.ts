/**
 * ArgoLink models, called directly with the operator's own `ARGOLINK_API_KEY` instead of
 * through the treg gateway. Like the other local backends they quote $0 here: ArgoLink
 * bills the operator's account, not the member's credits. See `src/server/providers/argolink.ts`.
 *
 * `build` produces the stored job body `{ path, call, media }`: `call` is ArgoLink's own JSON,
 * with each reference file written as a token (`@m0`) that points into `media`. The server
 * uploads the files to ArgoLink and swaps the tokens for the URLs it gets back.
 */
import { aspect, audio, duration, resolution } from "./helpers";
import type { BuildContext, BuiltRequest, Control, MediaRef, MediaSlot, ModelDef } from "./types";

export const ARGOLINK_PREFIX = "argolink.";
export const ARGOLINK_IMAGE = "argolink.image";
export const ARGOLINK_VIDEO = "argolink.video";

export const ARGOLINK_PATHS = {
  image: "/v1/images/generations",
  edit: "/v1/images/edits",
  video: "/v1/videos/generations",
} as const;

const PROMPT = { required: true, maxLength: 2500, placeholder: "Describe the shot: subject, action, camera, light." };
const REFS_HINT = "Pictures the model should take its look from.";

/** Collects the files of one request and hands back a token for each. */
function tray() {
  const media: Record<string, { data: string; mime: string }> = {};
  const token = (ref: MediaRef) => {
    const key = `@m${Object.keys(media).length}`;
    media[key] = { data: ref.data, mime: ref.mime };
    return key;
  };
  return { media, token };
}

const refs = (max: number): MediaSlot => ({ id: "refs", label: "Reference images", hint: REFS_HINT, accept: ["image"], min: 0, max });
const START: MediaSlot = { id: "start", label: "Start frame", hint: "The first frame of the shot.", accept: ["image"], min: 0, max: 1 };
const END: MediaSlot = { id: "end", label: "End frame", hint: "The shot lands on this image.", accept: ["image"], min: 0, max: 1, when: { "slot:start": "filled" } };
const SOURCE: MediaSlot = { id: "source", label: "Source video", hint: "The clip to change or continue.", accept: ["video"], min: 1, max: 1 };

const SIX = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"];
const BADGES = ["Own key"];

/* ---------------------------------- image ---------------------------------- */

const grokImage: ModelDef = {
  id: "argolink-grok-image",
  kind: "image",
  name: "Grok Imagine",
  vendor: "ArgoLink",
  tagline: "Grok's image model through your own ArgoLink key. Add up to 3 pictures to edit.",
  badges: BADGES,
  status: "available",
  surfaces: ["image"],
  prompt: { required: true, maxLength: 2000, placeholder: "Describe the image: subject, setting, light, mood." },
  slots: [refs(3)],
  controls: [aspect(["1:1", "16:9", "9:16", "4:3", "3:4", "auto"], "1:1"), resolution(["1k", "2k"], "1k")],
  batch: { max: 4, native: false },
  output: "image",
  eta: 20,
  build({ prompt, values, media }: BuildContext): BuiltRequest {
    const t = tray();
    const given = media.refs ?? [];
    const shared = { model: "grok-imagine-image-2.0", prompt, aspect_ratio: values.aspect, resolution: values.resolution, n: 1, response_format: "url", quality: "auto" };
    const edit = given.length > 0;
    const call = edit ? { ...shared, images: given.map((r) => ({ image_url: t.token(r) })) } : shared;
    return { endpoint: ARGOLINK_IMAGE, body: { path: edit ? ARGOLINK_PATHS.edit : ARGOLINK_PATHS.image, call, media: t.media } };
  },
};

/* ---------------------------------- video ---------------------------------- */

interface Spec {
  id: string;
  /** ArgoLink's own model name, sent as `model`. */
  model: string;
  name: string;
  tagline: string;
  resolutions: string[];
  aspects?: string[];
  /** With a start frame the picture decides the shape, and ArgoLink wants `adaptive`. */
  adaptive: boolean;
  seconds: { min: number; max: number };
  defaultSeconds: number;
  sound: boolean;
  eta: number;
}

function argoVideo(s: Spec): ModelDef {
  const controls: Control[] = [aspect(s.aspects ?? SIX, "16:9"), duration(s.seconds, s.defaultSeconds), resolution(s.resolutions, s.resolutions.includes("720p") ? "720p" : s.resolutions[0])];
  if (s.sound) controls.push(audio(true));
  return {
    id: s.id,
    kind: "video",
    name: s.name,
    vendor: "ArgoLink",
    tagline: s.tagline,
    badges: BADGES,
    status: "available",
    surfaces: ["video"],
    prompt: PROMPT,
    slots: [START, END, refs(4)],
    controls,
    batch: { max: 4, native: false },
    output: "video",
    eta: s.eta,
    build({ prompt, values, media }: BuildContext): BuiltRequest {
      const t = tray();
      const start = media.start?.[0];
      const end = media.end?.[0];
      const given = media.refs ?? [];
      const shared = {
        model: s.model,
        prompt,
        duration: Number(values.duration),
        resolution: values.resolution,
        ...(s.sound ? { generate_audio: Boolean(values.audio) } : {}),
      };
      let call: Record<string, unknown>;
      if (start) {
        call = { ...shared, aspect_ratio: s.adaptive ? "adaptive" : values.aspect, start_image: { url: t.token(start) }, ...(end ? { end_image: { url: t.token(end) } } : {}) };
      } else if (given.length > 0) {
        call = { ...shared, aspect_ratio: values.aspect, reference_images: given.map((r) => ({ url: t.token(r) })) };
      } else {
        call = { ...shared, aspect_ratio: values.aspect };
      }
      return { endpoint: ARGOLINK_VIDEO, body: { path: ARGOLINK_PATHS.video, call, media: t.media } };
    },
  };
}

/** Seedance 2.5 on a clip you supply: change it, or make it longer. */
function seedanceClip(kind: "edit" | "extend"): ModelDef {
  const extend = kind === "extend";
  const controls: Control[] = [resolution(["480p", "720p"], "720p"), audio(true)];
  if (extend) controls.unshift(duration({ min: 4, max: 30 }, 8, "Added length"));
  return {
    id: `argolink-seedance-2.5-${kind}`,
    kind: "video",
    name: extend ? "Seedance 2.5 Extend" : "Seedance 2.5 Edit",
    vendor: "ArgoLink",
    tagline: extend ? "Continues a clip you supply." : "Changes a clip you supply, as you describe.",
    badges: BADGES,
    status: "available",
    surfaces: ["video"],
    prompt: PROMPT,
    slots: [SOURCE, refs(4)],
    controls,
    batch: { max: 4, native: false },
    output: "video",
    eta: 150,
    build({ prompt, values, media }: BuildContext): BuiltRequest {
      const t = tray();
      const given = media.refs ?? [];
      const call = {
        model: "seedance-2.5",
        omni_reference_task_type: kind,
        prompt,
        resolution: values.resolution,
        ...(extend ? { duration: Number(values.duration) } : {}),
        generate_audio: Boolean(values.audio),
        reference_videos: (media.source ?? []).map((r) => ({ url: t.token(r) })),
        ...(given.length ? { reference_images: given.map((r) => ({ url: t.token(r) })) } : {}),
      };
      return { endpoint: ARGOLINK_VIDEO, body: { path: ARGOLINK_PATHS.video, call, media: t.media } };
    },
  };
}

const grokVideo: ModelDef = {
  id: "argolink-grok-video",
  kind: "video",
  name: "Grok Imagine Video",
  vendor: "ArgoLink",
  tagline: "Grok's video model. Add pictures to make the clip from them.",
  badges: BADGES,
  status: "available",
  surfaces: ["video"],
  prompt: PROMPT,
  slots: [refs(3)],
  controls: [
    aspect(["16:9", "9:16", "1:1"], "16:9"),
    duration({ min: 1, max: 15 }, 6),
    // ArgoLink refuses 1080p when pictures are attached.
    resolution(
      [
        { value: "480p", label: "480p" },
        { value: "720p", label: "720p" },
        { value: "1080p", label: "1080p", when: { "slot:refs": "empty" } },
      ],
      "720p",
    ),
  ],
  batch: { max: 4, native: false },
  output: "video",
  eta: 90,
  build({ prompt, values, media }: BuildContext): BuiltRequest {
    const t = tray();
    const given = media.refs ?? [];
    const call = {
      model: "grok-imagine-video-1.5",
      prompt,
      duration: Number(values.duration),
      resolution: values.resolution,
      ...(given.length ? { reference_images: given.map((r) => ({ url: t.token(r) })) } : { aspect_ratio: values.aspect }),
    };
    return { endpoint: ARGOLINK_VIDEO, body: { path: ARGOLINK_PATHS.video, call, media: t.media } };
  },
};

export const argolinkModels: ModelDef[] = [
  grokImage,
  argoVideo({ id: "argolink-seedance-2.5", model: "seedance-2.5", name: "Seedance 2.5", tagline: "ByteDance's newest video model, up to 30 seconds with sound.", resolutions: ["480p", "720p", "1080p"], adaptive: true, seconds: { min: 4, max: 30 }, defaultSeconds: 8, sound: true, eta: 150 }),
  seedanceClip("edit"),
  seedanceClip("extend"),
  argoVideo({ id: "argolink-seedance-2", model: "seedance-2.0", name: "Seedance 2.0", tagline: "Cinematic motion with sound, up to 4K.", resolutions: ["480p", "720p", "1080p", "4k"], adaptive: false, seconds: { min: 4, max: 15 }, defaultSeconds: 8, sound: true, eta: 150 }),
  argoVideo({ id: "argolink-seedance-2-fast", model: "seedance-2.0-fast", name: "Seedance 2.0 Fast", tagline: "Seedance 2.0, quicker.", resolutions: ["480p", "720p"], adaptive: false, seconds: { min: 4, max: 15 }, defaultSeconds: 8, sound: true, eta: 90 }),
  argoVideo({ id: "argolink-seedance-2-mini", model: "seedance-2.0-mini", name: "Seedance 2.0 Mini", tagline: "The lightest Seedance, for drafts.", resolutions: ["480p", "720p"], adaptive: false, seconds: { min: 4, max: 15 }, defaultSeconds: 8, sound: true, eta: 60 }),
  argoVideo({ id: "argolink-wan-3", model: "wan-3", name: "Wan 3.0", tagline: "Alibaba's video model, 2 to 30 seconds.", resolutions: ["480p", "720p", "1080p"], adaptive: false, seconds: { min: 2, max: 30 }, defaultSeconds: 5, sound: false, eta: 120 }),
  argoVideo({ id: "argolink-wan-3-prime", model: "wan-3-prime", name: "Wan 3.0 Prime", tagline: "The higher tier of Wan 3.", resolutions: ["480p", "720p", "1080p"], adaptive: false, seconds: { min: 2, max: 30 }, defaultSeconds: 5, sound: false, eta: 150 }),
  argoVideo({ id: "argolink-minimax-h3", model: "minimax-h3", name: "Hailuo H3", tagline: "MiniMax's newest model, sharp up to 2K.", resolutions: ["768p", "2k"], aspects: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"], adaptive: true, seconds: { min: 4, max: 15 }, defaultSeconds: 6, sound: false, eta: 150 }),
  grokVideo,
];
