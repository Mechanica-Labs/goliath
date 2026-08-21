# Brand asset provenance

`goliath-brand.svg` is the editable source for the Goliath brand artwork. It
was created specifically for this repository from simple geometric SVG shapes
and contains no third-party imagery or embedded font files.

The PNG and JPEG files in this directory are deterministic raster derivatives
of that SVG source:

- `goliath-social-preview-1280x640.png` — 1280 by 640
- `goliath-social-preview-640x320.png` — 640 by 320
- `goliath-art.png` — 1672 by 941, padded to 16:9
- `goliath-logo.jpg` — 1920 by 1080, padded to 16:9

Regenerate them with macOS `sips` and ImageMagick from the repository root:

```sh
sips -s format png assets/goliath-brand.svg --out assets/goliath-social-preview-1280x640.png
sips -z 320 640 assets/goliath-social-preview-1280x640.png --out assets/goliath-social-preview-640x320.png
magick assets/goliath-social-preview-1280x640.png -resize 1672x941 -background '#080b14' -gravity center -extent 1672x941 PNG24:assets/goliath-art.png
magick assets/goliath-social-preview-1280x640.png -resize 1920x1080 -background '#080b14' -gravity center -extent 1920x1080 -quality 92 assets/goliath-logo.jpg
```
