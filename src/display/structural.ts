import type { Theme } from "@earendil-works/pi-coding-agent";
import type { AstConstraints, RequestView } from "../presentation.ts";
import { toJson } from "../json.ts";
import { structuredLines } from "./structured.ts";
import { sourceLines, wrap } from "./text.ts";

type StructuralRequest = Extract<RequestView, { kind: "change.structural" | "search.ast" }>;

export function structuralRequestLines(request: StructuralRequest, width: number, theme: Theme): string[] {
	const lines: string[] = [];
	const source = (label: string, text: string, language: string) => {
		lines.push(theme.fg("dim", label), ...sourceLines({ text, language }, undefined, width, false, theme));
	};
	let constraints: AstConstraints | undefined;
	if (request.kind === "change.structural") {
		source("Pattern", request.pattern, request.language);
		source("Replacement template", request.rewrite, request.language);
		constraints = request.constraints;
	} else if (request.selector.kind === "rule") source("Rule", request.selector.rule, "yaml");
	else if (request.selector.kind === "pattern") {
		source("Pattern", request.selector.pattern, request.language);
		if (request.selector.selector !== undefined) lines.push(...wrap(`Selector: ${request.selector.selector}`, width));
	} else {
		if (request.selector.pattern !== undefined) source("Pattern", request.selector.pattern, request.language);
		constraints = request.selector.constraints;
	}
	if (constraints && Object.keys(constraints).length) {
		const data = toJson(constraints);
		if (data !== undefined) lines.push(theme.fg("dim", "Constraints"), ...structuredLines(data, width));
	}
	if (request.paths?.length && (request.kind === "search.ast" || request.paths.length > 1)) {
		lines.push(...wrap(`Paths: ${request.paths.join(", ")}`, width));
	}
	return lines;
}
