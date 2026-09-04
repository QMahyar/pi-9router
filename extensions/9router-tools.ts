/**
 * pi-9router-tools — Capability tools for 9Router (companion to 9router.ts)
 *
 * Config UI: /9router-tools
 *
 * Tools (toggle in UI; off tools are removed from the model context):
 *   nr_image_generate  POST /v1/images/generations
 *   nr_tts             POST /v1/audio/speech
 *   nr_video_generate  POST /v1/videos/generations (+ GET /v1/videos/{id} poll)
 *   nr_stt             POST /v1/audio/transcriptions (multipart; default off)
 *   nr_embed           POST /v1/embeddings
 *   nr_web_search      POST /v1/search
 *   nr_web_fetch       POST /v1/web/fetch
 *
 * This is the entry/wiring file: model resolution lives in
 * `lib/model-resolve.ts`, shared execution helpers in `lib/toolkit.ts`, the
 * media tool implementations in `lib/tools-media.ts`, the web tool
 * implementations in `lib/tools-web.ts`, and the registration wrappers + TUI
 * in `lib/tools-register.ts`. The bottom re-exports the documented
 * test/script seam.
 *
 * Voice → editor dictation is still out of scope (use an OS dictation app);
 * nr_stt covers transcribing existing audio files.
 *
 * Tool descriptions stay compact — they name the configured default model, not
 * the full catalog. A `model` argument is resolved against the catalog before
 * any request goes out; unknown ids are rejected with the available list.
 * Video has no catalog list endpoint — its tool falls back to the documented
 * `xai/grok-imagine-video` id (see lib/model-resolve.ts).
 *
 * Wire convention: /v1/images/generations, /v1/audio/speech, /v1/embeddings,
 * /v1/audio/transcriptions take the full catalog id; /v1/search and
 * /v1/web/fetch take a bare provider name.
 *
 * Shared config: ~/.pi/agent/9router.json
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  applyToolActivation,
  registerAllTools,
  runNineRouterToolsUI,
} from "./lib/tools-register.ts";
import { loadRaw, saveRaw } from "./lib/model-resolve.ts";
import {
  CAPS,
  footerFromConfig,
  hasLegacyKeys,
  isSyncStale,
  paintFooterStatus,
} from "./lib/shared.ts";

export default function (pi: ExtensionAPI) {
  registerAllTools(pi, loadRaw());

  const applyFromDisk = () => applyToolActivation(pi, loadRaw());

  const refreshFooter = (ui: ExtensionContext["ui"]) => {
    paintFooterStatus(ui, footerFromConfig());
  };

  pi.on("session_start", async (_event, ctx) => {
    if (hasLegacyKeys()) saveRaw({}); // one-time strip for older installs
    applyFromDisk();
    if (ctx.hasUI) refreshFooter(ctx.ui);
  });

  pi.events.on("9router:synced", () => {
    registerAllTools(pi, loadRaw());
    applyFromDisk();
  });

  pi.registerCommand("9router-tools", {
    description:
      "9Router tools — enable image, speech, search, fetch; set defaults",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI && ctx.mode !== "tui") {
        ctx.ui.notify("/9router-tools needs interactive mode", "error");
        return;
      }
      if (!loadRaw().catalog?.length) {
        ctx.ui.notify(
          "Catalog empty — open /9router and sync models first.",
          "warning",
        );
      } else if (isSyncStale(loadRaw().lastSync)) {
        ctx.ui.notify(
          "Catalog is stale (>24h). Consider /9router → Sync models.",
          "warning",
        );
      }
      await runNineRouterToolsUI(pi, ctx);
      applyFromDisk();
      if (ctx.hasUI) refreshFooter(ctx.ui);
    },
  });
}


// Test helpers / documented export surface
export { CAPS } from "./lib/shared.ts";
export {
	describeModels,
	isAutoRichDefault,
	isVideoPassthroughId,
	modelsForCap,
	getCapState,
	resolveModel,
	withModelHint,
	VIDEO_DEFAULT_MODEL,
} from "./lib/model-resolve.ts";
export { gateUsageRec, loadImageRef, needCap } from "./lib/toolkit.ts";
export {
	generateImages,
	isFatalMediaStatus,
	planImageBatch,
	videoCreateError,
	videoPollChanged,
	VIDEO_POLL_INTERVAL_MS,
} from "./lib/tools-media.ts";
