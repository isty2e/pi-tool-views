import type { Component } from "@earendil-works/pi-tui";
import { compositionParts } from "./display/row.ts";
import type { CompositionParts } from "./display/row.ts";

export { compositionParts };
export type { CompositionParts, NestedSnapshot } from "./display/row.ts";

export function getToolViewParts(component: Component): CompositionParts | undefined {
  return (component as Component & { readonly [compositionParts]?: CompositionParts })[compositionParts];
}
