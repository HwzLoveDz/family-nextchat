# Family workspace secondary controls

`WorkspaceSelect` is shared by model, reasoning, image, voice, settings and usage
filters. Its controlled value remains in the owning feature; opening a popup,
hovering an option or moving through options never changes settings or sends a
generation request. Selecting the current value only closes the popup.

- The compact trigger shows the selected label and a chevron. Field controls add
  a thin input border. Descriptions appear inside the popup, below option names.
- Groups use a small section heading; a check marks the committed choice and a
  muted background marks the pointer or keyboard preview.
- Arrow keys, Home and End navigate, Enter or Space selects, Escape dismisses,
  and Tab dismisses while preserving normal focus movement. Typeahead searches
  option labels. Pointer selection retains trigger focus.
- Popups stay in the feature DOM for theme inheritance and dialog focus trapping.
  Fixed positioning chooses available space above or below the trigger, clamps
  to the visual viewport and allows internal scrolling. Outside interactions,
  page scrolling, resize and loss of window focus dismiss the popup.
- In settings, the first Escape closes an expanded choice popup; the next Escape
  closes the dialog. Identity and session guards remain owned by the feature.

All surfaces use the existing twelve-theme tokens (`--paper`, `--ink`, `--muted`,
`--line`, `--hover`, `--focus` and `--app-shadow`). Focus rings and disabled states
remain distinct from selected and hovered states. Conversation menus share the
same radii, spacing and neutral hover treatment, with icons and a separated
archive action.

Usage charts explicitly preserve SVG colors. They must not inherit the legacy
dark-mode `invert(.5)` filter, which maps every series color to gray. Legends and
segments share the same palette; unknown costs remain unknown.
