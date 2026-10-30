import type { EffectiveDeclaration, FamilyProjection, Json } from "../presentation.ts";
import { compileRequest, type RequestMatch } from "./request.ts";
import { compileResult } from "./result.ts";

function uninterpreted(): { readonly kind: "uninterpreted" } {
	return { kind: "uninterpreted" };
}

function originalResult() {
	return { parts: [{ kind: "original-content" as const }] as const };
}

/** Compile a declaration into a pure request/result projection. */
export function compileProjection(declaration: EffectiveDeclaration | undefined): FamilyProjection {
	if (!declaration) {
		return {
			request: (_args: Json) => uninterpreted(),
			result: (_result) => originalResult(),
		};
	}

	const match: RequestMatch | undefined = compileRequest(declaration);
	if (!match) {
		return {
			request: (_args: Json) => uninterpreted(),
			result: (_result) => originalResult(),
		};
	}

	const result = compileResult(match.family, declaration);
	return {
		request: (args) => match.construct(args) ?? uninterpreted(),
		result,
	};
}
