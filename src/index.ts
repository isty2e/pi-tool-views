import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ToolViewsRuntime } from "./host/runtime.ts";
import { compileProjection } from "./projection/index.ts";
import { buildDiffPresentation } from "./diff/index.ts";
import { renderToolDiff } from "./display/diff.ts";

export default function toolViews(pi: ExtensionAPI): void {
  new ToolViewsRuntime(pi, { compile: compileProjection, compare: buildDiffPresentation, renderDiff: renderToolDiff }).install();
}
