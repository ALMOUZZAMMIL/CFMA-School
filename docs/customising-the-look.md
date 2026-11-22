# Changing the look of the portal

You do not need to know how to program to change the colours, sizes or
corners of the portal. Everything lives in one place.

## 1. School colours (no file editing)

Sign in as an administrator and open **Administration > Settings**.
The primary (blue), accent (green) and secondary (purple) colours you set
there are applied to every page straight away.

## 2. Everything else: the "EASY SETTINGS" block

Open `public/style.css`. The first block, between
`EASY SETTINGS` and `END OF EASY SETTINGS`, holds every value you might
want to change. Each line has a comment saying what it does. Change the
value, save the file and reload the page (Ctrl+F5 to skip the cache).

| What you want | Setting | Example |
|---|---|---|
| Lighter or darker page background | `--bg` | `#ffffff` for plain white |
| Colour of the side menu | `--sidebar-bg` | `#1d3b2a` for dark green |
| Colour of the selected menu item | `--sidebar-active` | `var(--accent)` for green |
| Wider or narrower side menu | `--sidebar-w` | `240px` |
| Colours of the four figure tiles on the home page | `--tile-1` to `--tile-4` | any colour, e.g. `#0e7490` |
| Square or rounder cards | `--radius` | `0` for square, `16px` for round |
| Visible border around cards | `--card-border` | `#e5e7eb` |
| Stronger or softer card shadow | `--shadow-card` | `none` to remove it |
| More or less space between cards | `--gap` | `1rem` |
| Bigger buttons and inputs | `--control-h` | `44px` |
| Font | `--font`, `--font-head` | `Arial, sans-serif` |

Tips:

- Colours are written as `#rrggbb`. Any online "colour picker" gives you
  this code.
- Change one value at a time and reload, so you can see what it did.
- If something looks wrong, undo your change: the original values are
  kept in git (`git checkout public/style.css`).
- Keep enough contrast between text and background so the portal stays
  readable on cheap phones in bright light.

## 3. Words and translations

All visible text is in `locales/en.json` (English) and `locales/fr.json`
(French). Change the wording there, never in the page templates. Run
`npm run check-i18n` afterwards: it tells you if a text exists in one
language but not the other.

## 4. Rules to keep

- No `style="..."` attributes and no inline `<script>`: the browser blocks
  them for security (Content Security Policy). Add a class in
  `style.css` instead.
- Pages must still work without JavaScript.

## Credits

The dashboard layout (dark side menu, figure tiles with round icons,
cards with a title strip) takes its inspiration from the free
[Kiaalap](https://github.com/puikinsh/kiaalap) admin template by Colorlib,
released under the MIT licence. No code, images or other files from
Kiaalap are used in this portal; the styles were written from scratch for
the school's colours and needs.
