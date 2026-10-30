# Settings

Run `/tool-views` in Pi. Use arrows to select/cycle, Enter to choose a value, and
**Save** or **Cancel**. Layout changes preview existing cards without writing files.
Initial source visibility applies to new cards only after Save. Switching a dirty
save target offers Save, Discard, or Stay.

## Configuration files

Settings merge in this order:

1. Built-in defaults.
2. `tool-views.json` in the host's agent directory.
3. `.pi/tool-views.json` in the current working directory.

The project file is not searched in parent directories. Omit a key to inherit it.
For example:

```json
{
  "diffMode": "split",
  "resultRows": 12,
  "horizontalRules": "both"
}
```

## Options

| Key | Default | Values |
| --- | --- | --- |
| `titleMode` | `"action"` | `"action"`, `"tool"` |
| `showDuration` | `true` | Boolean |
| `lineNumbers` | `true` | Boolean |
| `backdrop` | `false` | Boolean |
| `horizontalRules` | `"none"` | `"none"`, `"top"`, `"bottom"`, `"both"` |
| `resultRows` | `12` | Nonnegative integer, or `null` for unlimited |
| `shellWindow` | `"head-tail"` | `"head"`, `"tail"`, `"head-tail"` |
| `commandPreview` | `true` | Boolean; controls the command excerpt in the title |
| `shellSourceInitiallyVisible` | `false` | Boolean |
| `codeInitiallyVisible` | `false` | Boolean |
| `diffMode` | `"auto"` | `"native"`, `"unified"`, `"split"`, `"auto"` |
| `diffContext` | `3` | Nonnegative integer |
| `diffEmphasisGap` | `2` | Nonnegative safe integer; `0` disables emphasis grouping |
| `diffRowBackground` | `false` | Boolean |

### Diff layouts and emphasis

Select Native, Unified, Split or Auto in `/tool-views`; there is no per-card layout
toolbar. Auto chooses a layout per supplied file or report region. Split requires
enough room and a paired before/after change; other regions use Unified. Explicit
layout choices still apply.

Native uses the original renderer when its callable delegates are available,
otherwise a labeled supplied-change view. Native renderers own their formatting
options. Tool Views' Unified and Split layouts give changed gutters a subtle
red/green background without enabling whole-row tint by default.

Tool Views groups nearby diff emphasis when the unchanged gap is at most
`diffEmphasisGap` user-visible characters. Grouping is transitive within each paired
line: a highlighted common region is included on both sides, so the unhighlighted
text still matches. A valid isolated change does not expand. Distance uses
displayed graphemes, not terminal columns: invisible controls do not count, and tabs
use their existing four-space expansion. If normalization breaks character
boundaries, both lines use full-text emphasis. Set `0` for ungrouped emphasis.
Exact comparisons and original inspection are unchanged; delegated Native
formatting remains its renderer's choice.

### Result previews

The result row budget includes its omission marker, but not controls or decoration.
Zero hides the preview, not the full-result control or native images. Producer
truncation is separate from UI clipping: expanding cannot recover bytes the
producer did not return.

### Card expansion

Per-card expansion choices are independent of the host's card expansion. They
survive ordinary redraws, configuration previews and same-session component
rebuilds, but are not saved to session files. They reset on session changes,
extension reload or process restart.

Shell commands and program source start collapsed unless the initial visibility
setting or a per-call choice says otherwise. Opening an outer item does not force
the inner source open; automatic cross-extension source-disclosure synchronization
is unsupported.

### Rules and images

Pi owns native images; Tool Views does not re-encode or thumbnail them. An enabled
bottom rule belongs after the images, not between text and images. When no safe
post-image slot is available, that bottom rule is omitted; text, images, top rules
and the saved setting remain. Ordinary text-only cards can draw their bottom rule
without host patching.

## Saving and external edits

External file edits are picked up automatically. Invalid or unreadable edits keep
the last valid layer and appear as diagnostics in the menu. Save replaces only the
selected file, using a temporary file and rename. A detected external edit or write
failure leaves the draft open. This detects conflicting edits; it is not a lock
against arbitrary concurrent editors. Menu Save refuses a symbolic-link target;
edit the managed file directly instead.
