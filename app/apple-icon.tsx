import { ImageResponse } from "next/og";
import {
  LOGO_GRADIENT_FROM,
  LOGO_GRADIENT_TO,
  LOGO_PATH,
  LOGO_STROKE_WIDTH,
  LOGO_VIEWBOX,
} from "@/lib/logo";

// iOS home-screen icon. Generated as a PNG (Apple ignores SVG touch icons) via
// next/og — no extra dependency. Dark square + the blue→teal Allos wave; iOS
// rounds corners.
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

const markSvg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='${LOGO_VIEWBOX}'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='0'><stop offset='0' stop-color='${LOGO_GRADIENT_FROM}'/><stop offset='1' stop-color='${LOGO_GRADIENT_TO}'/></linearGradient></defs><path d='${LOGO_PATH}' fill='none' stroke='url(#g)' stroke-width='${LOGO_STROKE_WIDTH}' stroke-linecap='round' stroke-miterlimit='10'/></svg>`;

export default function AppleIcon() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#0b100e",
      }}
    >
      {/* Wave mark; aspect ratio 164:106 ≈ 1.55. next/og renders via satori, which
          only supports a raw <img>; next/image doesn't work here. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        width={130}
        height={84}
        src={`data:image/svg+xml;utf8,${encodeURIComponent(markSvg)}`}
        alt=""
      />
    </div>,
    { ...size }
  );
}
