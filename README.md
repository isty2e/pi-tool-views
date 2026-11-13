# Pi Tool Views

Readable tool output for Pi, with compact action titles, syntax-highlighted source
previews, and unified or side-by-side diffs. Tool Views changes how tool calls and
results look, not how tools execute or what they return.

- **Read and search:** highlighted source, file locations, line numbers and matching
  rows marked with `›`.
- **Review changes:** unified or side-by-side diffs with inline change emphasis.
  Auto chooses between them; Native can use the original renderer. Patch batches
  keep their file operations together in one card.
- **Keep output short:** bounded result previews, expandable command/source, and
  full results when you need them. Shell previews can show the head, tail, or both.
- **Inspect from the keyboard:** browse full arguments, source/diffs and results
  without changing the card's expansion state.

[Install](#install) · [Tool examples](#supported-tools) · [Use](#use) · [Customize](#customize)

## Install

Tool Views is not published yet. To use a local checkout, you need Node.js 22.18
or newer and a Pi host compatible with the 1.4.0 extension APIs.

From the checkout, install its runtime dependencies:

```sh
npm ci --omit=dev
```

Live diff previews can read local target files before the editing tool's approval;
see [file context and read limits](docs/tools.md#live-file-context).

Try it for one standalone Pi session:

```sh
pi --no-extensions -e ./src/index.ts
```

This skips other automatically loaded extensions for this run without changing
Pi's saved package list. To register the checkout for later sessions instead:

```sh
pi install .
```

Pi saves this declaration in personal settings; add `-l` for the current project
only. Local packages load directly from the checkout, so keep that directory and
its dependencies available.

## Supported tools

Tool Views formats built-in tools and compatible third-party tools. These are
examples, not an exhaustive list. Install third-party tools separately, with their
own authentication and provider setup.

Each group below has a light/dark pair. Open an image at full size to inspect the
text. The captures replay saved calls with illustrative paths, URLs and labels,
without rerunning the underlying tools or remote services. Command and
program source are expanded, and the edit example compares Unified and Split
layouts. Other display settings use their defaults.

### File and source reads

Pi `read`, Hashline `read`, and Lens `read_symbol` / `read_enclosing`: syntax colors,
line identifiers and known source ranges. This example shows a text read and its
returned line range, with a separate continuation notice.

| Light | Dark |
| --- | --- |
| ![File read in the light theme](docs/images/read-light.png) | ![File read in the dark theme](docs/images/read-dark.png) |

### Search and file listings

Pi `grep` / `find` / `ls`, FFF search tools, and Lens symbol/AST search. This FFF
example marks matching rows with `›` and keeps context and file annotations.
File discovery and directory results use path lists.

| Light | Dark |
| --- | --- |
| ![FFF search in the light theme](docs/images/search-light.png) | ![FFF search in the dark theme](docs/images/search-dark.png) |

### File changes

Pi `write` / `edit`, `apply_patch` tools, Hashline edits and Mitsupi replacements.
The same edit is shown in Unified and Split layouts with inline change emphasis.
Patch batches can keep multiple file-operation sections together in one card.

During live execution, matching local file observations can fill in missing line
numbers and surrounding context. This does not reconstruct past file contents
when reopening old sessions. See [live file context](docs/tools.md#live-file-context)
for read timing and limits.

| Layout | Light | Dark |
| --- | --- | --- |
| Unified | ![Unified diff in the light theme](docs/images/changes-unified-light.png) | ![Unified diff in the dark theme](docs/images/changes-unified-dark.png) |
| Split | ![Split diff in the light theme](docs/images/changes-light.png) | ![Split diff in the dark theme](docs/images/changes-dark.png) |

### Commands and sessions

Pi `bash`, `exec_command`, `shell_command` and `write_stdin`: command source,
bounded output and returned status. This example shows a completed command with
its source expanded; session launch, poll and input tools use the same family.

| Light | Dark |
| --- | --- |
| ![Expanded shell command in the light theme](docs/images/shell-light.png) | ![Expanded shell command in the dark theme](docs/images/shell-dark.png) |

### Codemode and program execution

Native Codemode and `@boozedog/pi-codemode`, alongside compatible JavaScript and
TypeScript execution tools: expandable source and result previews. This Codemode
example shows the submitted program above its returned output, with the source
expanded and the result preview still bounded.

| Light | Dark |
| --- | --- |
| ![Expanded Codemode source in the light theme](docs/images/program-light.png) | ![Expanded Codemode source in the dark theme](docs/images/program-dark.png) |

### Code insight

Lens outlines, source/navigation, hover, diagnostics and module/project reports.
This syntax outline groups files, nested symbols and supplied locations.

| Light | Dark |
| --- | --- |
| ![Lens outline in the light theme](docs/images/code-light.png) | ![Lens outline in the dark theme](docs/images/code-dark.png) |

### Web tools

Web Access, Web Search and Codex-style web tools: queries, browsing actions,
fetches, source checks and stored-result slices. This two-target fetch retains one
returned page, one missing page and the provider's result text, including the
partial failure.

| Light | Dark |
| --- | --- |
| ![Partial web fetch in the light theme](docs/images/web-light.png) | ![Partial web fetch in the dark theme](docs/images/web-dark.png) |

### Image tools

`view_image` and image-generation requests, including supplied prompts/settings.
Pi handles image pixels. This crop shows the image-view card and its returned text
summary, not the native image itself. Tool Views does not re-encode images or make
thumbnails.

| Light | Dark |
| --- | --- |
| ![Image tool card in the light theme](docs/images/images-light.png) | ![Image tool card in the dark theme](docs/images/images-dark.png) |

See [tool coverage](docs/tools.md) for full package names, example releases and the
limits of specialized views.

## Use

Once loaded, Tool Views formats tool cards automatically. In Pi's terminal UI,
click the bracketed controls to open the parts you want to see:

- **Show command** or **Show source** opens a shell command or
  JavaScript/TypeScript source. Both start collapsed by default.
- **Show full result** and **Collapse result** switch between a preview and all
  content returned by the tool. Multi-operation cards use **Show full results**
  and **Collapse results**.
- **Show full arguments** opens the complete arguments on cards with a general
  argument preview; **Collapse arguments** returns to the preview.
- **Show reported changes**, when present, opens a matching change report that was
  collapsed to avoid repeating the preview. **Hide reported changes** closes it.

Type `/tool-views` followed by a space to see `inspect` and `help` suggestions.
Run `/tool-views help` for usage.

Opening the outer Pi card does not automatically open its command or source.
Expansion choices last for the current session; see
[card expansion](docs/settings.md#card-expansion) for their lifetime and defaults.

For keyboard access, run `/tool-views inspect`, select a call with ↑/↓, and press
Enter. Use ←/→ to switch between arguments, source/diff and result; ↑/↓ scrolls.
Esc returns to the list, then closes it. Inspection is read-only. Native images
stay in the transcript rather than being duplicated in this screen.

Expanding a result shows everything the tool returned, but cannot recover content
the tool itself truncated. Requests and previews are labeled separately from
reported changes; they do not establish which edits were applied. Warnings, errors
and partial-application information remain visible.

## Customize

Run `/tool-views` to choose a diff layout, adjust preview length, toggle line
numbers, or change initial source visibility. Display settings preview existing
cards before you **Save** or **Cancel**. Initial source-visibility defaults apply
only to new cards after Save.

Defaults use Auto diffs, line numbers and a 12-row result preview. Whole-row diff
tint is off. Auto uses Split where width and a paired before/after change allow it,
otherwise Unified.

See the [settings reference](docs/settings.md) for every option, configuration
files and save behavior.

## Compatibility

- The Pi integration targets the 1.4.0 APIs; checkout dependencies require Node.js
  22.18 or newer.
- Not every tool result has a specialized view; other data keeps a general
  argument/result presentation.
- Pi still handles images. If Tool Views cannot place a bottom rule after them,
  it leaves that rule out.
- The PiG frontend has limited support: card mouse controls and Native renderers are
  unavailable. Use `/tool-views inspect` to read full data.
