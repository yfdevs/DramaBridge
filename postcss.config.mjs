import smoothCorners from "postcss-smooth-corners";

export default {
  plugins: [
    smoothCorners({
      auto: true,
      // Scale the shared tokens as well as literal radii to preserve their
      // apparent size when the browser draws a squircle instead of an arc.
      props: /^--radius(?:-|$)/,
    }),
  ],
};
