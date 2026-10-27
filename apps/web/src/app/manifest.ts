import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "KisanTractor",
    short_name: "KisanTractor",
    description: "Responsive tractor-service booking platform",
    start_url: "/",
    display: "standalone",
    background_color: "#fffaf0",
    theme_color: "#006b3a",
  };
}
