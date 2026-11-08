import type { EffectiveDeclaration, FamilyProjection, Json } from "../presentation.ts";
import { compileRequest, type RequestMatch } from "./request.ts";
import { compileResult } from "./result.ts";
import { attachFileContext, operationArguments } from "./file-context.ts";
import { object } from "./schema.ts";

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
	const schema = declaration.input.kind === "json" ? object(declaration.input.schema) : undefined;
	return {
		request: (args) => attachFileContext(match.construct(match.family === "replacement" || match.family === "patch"
			? operationArguments(schema, args) : args) ?? uninterpreted(), schema, args, declaration.description),
		result,
	};
}
