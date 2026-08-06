/**
 * The Parakkat mark — a crowned P in a ring.
 *
 * Drawn as a CSS mask rather than an <img>, because the source artwork is pure white with no
 * outline. As an image it is invisible on every light surface in the app and can only ever be one
 * colour; as a mask the PNG supplies the SHAPE and `currentColor` supplies the colour, so the same
 * file works white inside the green sidebar tile, dark on the light login card, and light again in
 * dark mode — following the text around it without a second asset or a theme conditional.
 *
 * The fallback matters on the same point. If mask-image is unsupported the element would otherwise
 * render as a plain coloured square, so `@supports` gates the whole thing and anything that cannot
 * mask gets the image instead — legible, just not tintable.
 */
export default function BrandMark({ size = 16, className = '', title = 'Parakkat' }) {
  return (
    <span
      role="img"
      aria-label={title}
      className={`brand-mark ${className}`}
      style={{ width: size, height: size }}
    />
  );
}
