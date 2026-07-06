# Open Knowledge Format (OKF)

NeverWrite has partial support for the [Open Knowledge Format
(OKF)](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md),
a convention for describing knowledge documents through Markdown frontmatter.
This page documents the parts NeverWrite reads and surfaces: the `status`
extension field, the `type` field, and OKF vault detection.

OKF is permissive on consumption. NeverWrite never rejects a note for having an
unknown or missing field. Everything below is additive: notes without OKF
frontmatter render exactly as before.

## The `status` field

`status` is a NeverWrite extension to OKF frontmatter that signals a document's
publication and trust state. It is a single string value:

```markdown
---
title: Incident runbook
type: runbook
status: published
---
```

### Canonical values

| Value | Meaning |
| --- | --- |
| `draft` | Not yet published. |
| `in_review` | Under review; may change before publication. |
| `published` | Published and current. |
| `deprecated` | Outdated; kept but no longer authoritative. |
| `archived` | Kept for reference only. |

Values are normalized before display: they are trimmed, lowercased, and runs of
spaces or hyphens collapse to a single underscore (so `In Review` and
`in-review` both become `in_review`; the alias `review` also maps to
`in_review`). Unknown values are not dropped. They are shown verbatim (with
underscores rendered as spaces) using a neutral style, so a vault can use its
own status vocabulary without losing information.

Empty or whitespace-only values, and any non-string value, are treated as no
status.

### Status attribution (`status_by`)

When a status is set or changed through the editor's status menu, NeverWrite
also writes `status_by: <username>` directly after `status`, recording the
operating system account name of the person who made the change. The username
comes from the desktop session on macOS, Windows, and Linux alike; if it cannot
be determined, the field is omitted rather than filled with a placeholder.
Choosing "No status" removes both `status` and `status_by`. All other
frontmatter keys keep their order and content.

## Where status appears

- **File tree dot.** When "Show document status" is enabled (see below), each
  note with a status shows a small colored dot to the right of its label. The
  dot color maps to the status (green for `published`, amber for `draft`, and so
  on). Its tooltip shows the status label, plus the note's `type` when present,
  for example `Published · Runbook`. Notes whose status is `archived` or
  `deprecated` are dimmed in the tree.
- **Editor status badge.** The Markdown editor header shows a status badge in
  the breadcrumb row. Clicking it opens a menu to change or clear the status;
  the change is written back to frontmatter, preserving the order and content of
  every other key.
- **Editor trust banner.** For `draft`, `in_review`, `deprecated`, and
  `archived`, the editor shows a short banner under the toolbar explaining the
  state. `published` shows no banner.

## The `type` field

`type` is the standard OKF field describing the kind of document (for example
`runbook`, `reference`, `guide`). NeverWrite reads it as a plain string and
shows it as a muted badge in the editor header, and in the file tree status
dot's tooltip. Same string rules as `status`: only string scalars, trimmed;
empty resolves to absent.

## Settings

The file tree dot is controlled by a single toggle:

- **Settings → File Tree → Show document status** (`fileTreeShowDocumentStatus`),
  default on. This is a per-vault setting, scoped the same way as the other file
  tree settings.

Turning it off hides all status dots in the tree. It does not affect the editor
badge or banner.

## OKF vault detection (`okf_version`)

A vault is treated as an OKF vault when its root `index.md` declares an OKF
version in frontmatter. When detected, NeverWrite records the version
(`okf_version`) and uses it for conformance hints. For example, in an OKF vault a
note whose frontmatter has no non-empty `type` shows a muted "No OKF type" hint
in the editor header; clicking it opens the Properties panel so the field can be
added.

### Limitation

`okf_version` is computed once, when the vault is opened. It is not recomputed
while the vault is open. Editing the root `index.md` to add, change, or remove
the OKF version does not update detection live. Close and reopen the vault to
refresh it.
