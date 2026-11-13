# Settings

Run `/tool-views` in Pi's interactive UI. Use ↑/↓ to select, ←/→ to cycle, and
Enter to choose a value. The menu opens on the **Project** target; switch to
**Personal** to edit your defaults. Display settings preview existing cards
without writing files. Initial source visibility applies only to new cards after
**Save**; **Cancel** discards the draft.

Switching a target with unsaved changes offers **Save and switch**,
**Discard and switch**, or **Stay**. **Reload selected target** discards the draft
and reloads saved settings.

## Configuration files

Settings merge in this order:

1. Built-in defaults.
2. Personal settings: `~/.pi/agent/tool-views.json`, or `tool-views.json` under
   `PI_CODING_AGENT_DIR` when set.
3. Project settings: `.pi/tool-views.json` in Pi's current working directory.

The project file is not searched in parent directories. Omit a key, or choose
**Inherit** in the menu, to leave it unset in that file. Later layers override
earlier ones. For example:

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
| `resultRows` | `12` | Nonnegative safe integer, or `null` for unlimited |
| `shellWindow` | `"head-tail"` | `"head"`, `"tail"`, `"head-tail"` |
| `commandPreview` | `true` | Boolean; controls the command excerpt in the title |
| `shellSourceInitiallyVisible` | `false` | Boolean |
| `codeInitiallyVisible` | `false` | Boolean |
| `diffMode` | `"auto"` | `"native"`, `"unified"`, `"split"`, `"auto"` |
| `diffContext` | `3` | Nonnegative safe integer |
| `diffEmphasisGap` | `2` | Nonnegative safe integer; `0` disables emphasis grouping |
| `diffRowBackground` | `false` | Boolean |

The menu offers presets and preserves custom values already in the selected file.
JSON accepts any value allowed by the table. **Unlimited** sets `resultRows` to
`null`; it is different from **Inherit**, which removes the key from that file.

### Diff layouts and emphasis

Select Native, Unified, Split or Auto in `/tool-views`; there is no per-card layout
toolbar. Auto chooses a layout per supplied file or report region. Split requires
enough room and a paired before/after change; other regions use Unified. An explicit
Split choice also falls back to Unified if the terminal cannot fit both columns.

Native uses the tool's original change renderer when available. Otherwise, Tool
Views shows supplied changes in Unified layout with an availability notice. Native
renderers own their formatting options. Tool Views' Unified and Split layouts give
changed gutters a subtle red/green background without enabling whole-row tint by
default.

`diffContext` sets how many unchanged lines to show around a change. Context comes
from the supplied diff or retained [live file observations](tools.md#live-file-context);
changing this setting does not read files again.

`diffEmphasisGap` joins inline highlights separated by at most that many visible
characters. Nearby groups can join again within the same line; matching text in a
group is highlighted on both sides. An isolated highlight is unchanged. Distance
counts graphemes rather than terminal columns: invisible controls do not count,
and tabs expand to four spaces. Set `0` to leave separate highlights ungrouped.
Grouping changes emphasis, not the compared text. If precise highlight boundaries
are unavailable, both lines use full-text emphasis.

### Result previews

`resultRows` limits text-result previews, including multi-operation web output. The
budget includes its omission marker, but not controls or decoration. Zero hides
the preview, not the full-result control or native images. Tool truncation is
separate from UI clipping: expanding cannot recover bytes the tool did not return.

### Card expansion

Controls inside a card are separate from Pi's outer card expansion. Choices
survive ordinary redraws, configuration previews and same-session component
rebuilds, but are not saved to session files. They reset on session changes,
extension reload or process restart.

Shell commands and program source start collapsed unless the initial visibility
setting or a per-call choice says otherwise. Opening the outer card does not open
its command or source; Tool Views does not synchronize source visibility with
other UI extensions.

### Rules and images

Pi owns native images; Tool Views does not re-encode or thumbnail them. An enabled
bottom rule belongs after the images, not between text and images. When no safe
post-image slot is available, that bottom rule is omitted; text, images, top rules
and the saved setting remain. Text-only cards can draw their bottom rule normally.

## Saving and external edits

External file edits are picked up automatically. Invalid or unreadable edits keep
the last valid layer and appear as diagnostics in the menu. Save replaces only the
selected file, using a temporary file and rename. A detected external edit or write
failure leaves the draft open. This detects conflicting edits; it is not a lock
against arbitrary concurrent editors. Menu Save refuses a symbolic-link target;
edit the managed file directly instead.
