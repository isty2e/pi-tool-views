# Tool coverage

Tool Views adds presentation, not tools. Install and configure the tools you want
to use separately; their execution, authentication and provider setup are unchanged.

Support follows the tool's declared inputs and returned data, not its name or npm
package. The families below describe the dedicated views. A tool can have a
specialized title or input view while its result keeps the tool's original
text, Markdown or JSON. Ambiguous or unrecognized data uses a general view rather
than guessed fields.

## Tool families

| Family | What gets a dedicated view |
| --- | --- |
| File and source reads | Text reads, line selections, anchored/hashline reads, symbol reads and enclosing source. Syntax colors, supplied line identifiers and known locations stay together. |
| Search and listings | Text/regex search, multi-pattern literal search, AST search, ranked symbol results, file discovery and directory listings. Matches and context are distinct; path lists do not acquire invented line numbers. |
| File changes | Writes, exact replacements, patches, located/anchored edits, symbol edits and structural rewrites. Requested text or templates stay distinct from reported changes. Available before/after text can form Unified/Split diffs; live calls can add [local file context](#live-file-context). |
| Commands and sessions | Shell launches, process-session polling and input. Command source has its own disclosure; output has a bounded head, tail or head/tail preview. Returned status/error information is retained. |
| JavaScript and TypeScript | Program source and its result preview, including Codemode-style calls. A program body is not mixed into the tool's returned output. |
| Code insight | Outlines, nested document symbols, locations/navigation, hover, diagnostics and module/project reports. Supplied source and locations can be projected; other report text or fields remain available rather than being reinterpreted. |
| Web | Search queries, multiple queries, browsing actions, URL fetches, stored-result slices and source checks. Independent requested actions can have sections inside one call; provider content is retained, not universally decoded or restyled. |
| Images | Image-view and generation requests, including supplied prompts/settings and returned text/metadata. Pi handles native image display. |

See the [README examples](../README.md#supported-tools) for each family in light
and dark themes.

## Built-in Pi tools

The native tool interfaces include `read`, `write`, `edit`, `bash`, `grep`, `find`,
`ls` and Codemode. The native integration targets the Pi 1.4.0 APIs.

## Third-party examples

These published releases provide compatible examples for the listed tools. The
versions identify example interfaces, not minimum versions or a guarantee for
every tool in the package. Specialized coverage can vary by operation and returned
data even within a listed tool. Other tools and later releases can work when their
input/output formats fit the same families.

| Package | Example release | Tool interfaces |
| --- | --- | --- |
| [FFF](https://www.npmjs.com/package/@ff-labs/pi-fff) | `0.11.0` | `grep`, `find`, `multi_grep`, `ffgrep`, `fffind`, `fff-multi-grep` |
| [Lens](https://www.npmjs.com/package/pi-lens) | `4.4.4` | `read_symbol`, `read_enclosing`, `ast_grep_outline`, `ast_grep_search`, `ast_grep_replace`, `lsp_navigation`, `lens_diagnostics`, `module_report`, `project_report`, `symbol_search` |
| [Hashline Edit](https://www.npmjs.com/package/pi-hashline-edit) | `0.8.3` | Anchored `read`, `grep` and `edit` |
| [Mitsupi](https://www.npmjs.com/package/mitsupi) | `1.6.0` | Replacement `edit` |
| [Boozedog Codemode](https://www.npmjs.com/package/@boozedog/pi-codemode) | `0.5.1` | `codemode`, `replace_in_file`, `apply_patch` |
| [Unified Exec](https://www.npmjs.com/package/pi-unified-exec) | `0.13.1` | `exec_command`, `write_stdin` |
| [Codex Conversion](https://www.npmjs.com/package/@howaboua/pi-codex-conversion) | `4.0.4` | `apply_patch`, `exec_command`, `write_stdin`, `view_image` |
| [OpenAI Codex Compat](https://www.npmjs.com/package/pi-openai-codex-compat) | `0.0.29` | `apply_patch`, `exec_command`, `shell_command`, `write_stdin`, `web.run`, `image_gen.imagegen` |
| [Codex Edit](https://www.npmjs.com/package/@maxiaochao/pi-codex-edit) | `0.2.1` | `apply_patch` |
| [Pi Toolkit](https://www.npmjs.com/package/@maxiaochao/pi-toolkit) | `0.13.12` | `apply_patch` |
| [Codex Minimal Tools](https://www.npmjs.com/package/@vanillagreen/pi-codex-minimal-tools) | `2.1.5` | `apply_patch`, `view_image`, `image_generation` |
| [Codex Tools](https://www.npmjs.com/package/pi-codex-tools) | `0.4.0` | `apply_patch` |
| [Web Access](https://www.npmjs.com/package/pi-web-access) | `0.44.0` | `web_search`, `source_check`, `fetch_content`, `get_search_content` |
| [Web Search](https://www.npmjs.com/package/pi-web-search) | `1.7.0` | `web_search`, `url_context` |
| [Codex Web Run](https://www.npmjs.com/package/@howaboua/pi-codex-web-run) | `0.0.8` | `web_run` |
| [Codex Imagegen](https://www.npmjs.com/package/@howaboua/pi-codex-imagegen) | `0.0.11` | `imagegen` |

## What support does not imply

- Recognizing a request does not promise a specialized decoder for every result
  format. Web responses, command output, diagnostics and other reports can retain
  their supplied text/Markdown/JSON, with previews and inspection.
- A requested patch or rewrite is not proof it was applied. A reported file change
  takes precedence for that file. [Live file context](#live-file-context) can supply
  matching line numbers and surrounding rows, but does not establish which edits
  succeeded or reconstruct missing edits or historical before-images.
- A successful diagnostics invocation does not mean it found no errors. Tool
  execution status and the findings inside its result remain separate.
- Continuation, truncation and partial-result notices do not make omitted data
  available. Expanding a card shows only content returned by the tool.
- Dedicated MCP orchestration, subagent-progress and browser-action panels are not
  provided. Tools from those systems can still use an existing family when their
  data fits it, or the general argument/result view otherwise.
- Package-specific authentication, optional backends and execution dependencies
  remain each tool's responsibility. This list is about rendering, not a
  certification of their provider integrations or every published version.

## Live file context

For live file changes, Tool Views can match supplied diff hunks against local
files observed before and after execution to fill missing line numbers and
surrounding context. Matching does not change reported outcomes or prove that an
edit was applied. A write with no supplied before-image does not become a diff
through these reads.

Paths use the invocation's working directory unless the tool declares another
directory or execution environment. Explicit external or unresolved targets are
not read locally; undisclosed remote execution is not detected. Preflight reads
can happen before a later approval handler blocks the edit. Observations stay in
memory, are not added to model context or session history, and are discarded for
blocked calls.

Ambiguous matches, known overlapping calls, unsupported files and capture limits
keep the ordinary diff. Reopening old sessions does not read current files to
reconstruct past context. The [`diffContext` setting](settings.md#diff-layouts-and-emphasis)
controls how much available context is shown.

See [settings](settings.md) for card controls, defaults and configuration.
