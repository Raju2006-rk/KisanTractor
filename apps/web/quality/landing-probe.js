// Evaluated inside the page as `(source)(options)`. Plain JavaScript so the
// browser receives exactly this text, untouched by the test transpiler.
// Modes: "audit" (layout, accessibility, metadata), "focus" (the focused
// element), and "motion" (computed transitions and animations).
(options) => {
  const root = document.documentElement;
  const round = (value) => Math.round(value * 100) / 100;
  const describe = (element) => {
    if (!element) return null;
    const id = element.id ? `#${element.id}` : "";
    const classes = typeof element.className === "string" && element.className ? `.${element.className.trim().split(/\s+/).join(".")}` : "";
    const href = element.getAttribute && element.getAttribute("href") ? `[href="${element.getAttribute("href")}"]` : "";
    return `${element.tagName.toLowerCase()}${id}${classes}${href}`;
  };
  const parseColor = (value) => {
    const match = /rgba?\(([^)]+)\)/.exec(value || "");
    if (!match) return null;
    const parts = match[1].split(/[\s,/]+/).filter(Boolean).map((part) => (part.endsWith("%") ? Number.parseFloat(part) / 100 : Number(part)));
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  };
  const luminance = (color) => {
    const channel = (value) => {
      const srgb = value / 255;
      return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
  };
  const contrast = (first, second) => {
    const a = luminance(first);
    const b = luminance(second);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  };
  const blend = (top, bottom) => ({
    r: top.r * top.a + bottom.r * (1 - top.a),
    g: top.g * top.a + bottom.g * (1 - top.a),
    b: top.b * top.a + bottom.b * (1 - top.a),
    a: 1,
  });
  // Every opaque color that can sit behind an element: a solid fill, or each stop of a gradient.
  const backgrounds = (element) => {
    if (!element) return [{ r: 255, g: 255, b: 255, a: 1 }];
    const style = getComputedStyle(element);
    const below = () => backgrounds(element.parentElement);
    const stops = style.backgroundImage !== "none" ? [...style.backgroundImage.matchAll(/rgba?\([^)]+\)/g)].map((match) => parseColor(match[0])) : [];
    if (stops.length > 0) return stops.flatMap((stop) => (stop.a >= 1 ? [stop] : below().map((base) => blend(stop, base))));
    const fill = parseColor(style.backgroundColor);
    if (!fill || fill.a === 0) return below();
    if (fill.a >= 1) return [fill];
    return below().map((base) => blend(fill, base));
  };
  const visible = (element) => {
    if (typeof element.checkVisibility === "function" && !element.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 1 && rect.height > 1;
  };
  const accessibleName = (element) => {
    const label = element.getAttribute("aria-label");
    if (label) return label.trim();
    const clone = element.cloneNode(true);
    clone.querySelectorAll('[aria-hidden="true"]').forEach((node) => node.remove());
    return (clone.textContent || "").replace(/\s+/g, " ").trim();
  };
  const seconds = (value) => value.split(",").map((part) => {
    const text = part.trim();
    return text.endsWith("ms") ? Number.parseFloat(text) / 1000 : Number.parseFloat(text);
  });

  if (options.mode === "focus") {
    const element = document.activeElement;
    if (!element || element === document.body || element === root) return null;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const ring = parseColor(style.outlineColor);
    const behind = backgrounds(element.parentElement);
    return {
      element: describe(element),
      index: [...document.querySelectorAll(options.focusableSelector)].indexOf(element),
      focusVisible: element.matches(":focus-visible"),
      outlineStyle: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth) || 0,
      ringContrast: ring ? round(Math.min(...behind.map((base) => contrast(ring.a < 1 ? blend(ring, base) : ring, base)))) : 0,
      inViewport: rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < root.clientWidth,
    };
  }

  if (options.mode === "motion") {
    let longestTransition = 0;
    let longestAnimation = 0;
    for (const element of document.querySelectorAll("*")) {
      const style = getComputedStyle(element);
      const durations = seconds(style.transitionDuration);
      const delays = seconds(style.transitionDelay);
      durations.forEach((duration, index) => {
        longestTransition = Math.max(longestTransition, duration + Math.max(0, delays[index] ?? delays[0] ?? 0));
      });
      if (style.animationName !== "none") longestAnimation = Math.max(longestAnimation, ...seconds(style.animationDuration));
    }
    const hovered = options.hoverSelector ? document.querySelector(options.hoverSelector) : null;
    return {
      longestTransitionMs: round(longestTransition * 1000),
      longestAnimationMs: round(longestAnimation * 1000),
      runningAnimations: document.getAnimations().filter((animation) => animation.playState === "running").length,
      scrollBehavior: getComputedStyle(root).scrollBehavior,
      hoveredTransform: hovered ? getComputedStyle(hovered).transform : null,
      hoveredMatches: hovered ? hovered.matches(":hover") : false,
    };
  }

  const textElements = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.textContent.trim() && node.parentElement) textElements.add(node.parentElement);
  }
  const contrastFailures = [];
  const smallText = [];
  let smallestFontPx = Infinity;
  for (const element of textElements) {
    if (!visible(element)) continue;
    const style = getComputedStyle(element);
    const foreground = parseColor(style.color);
    const size = Number.parseFloat(style.fontSize);
    const weight = Number(style.fontWeight) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const required = large ? options.largeTextContrast : options.textContrast;
    const worst = Math.min(...backgrounds(element).map((base) => contrast(foreground.a < 1 ? blend(foreground, base) : foreground, base)));
    if (worst < required) contrastFailures.push({ element: describe(element), text: element.textContent.trim().slice(0, 40), ratio: round(worst), required });
    if (!element.closest('[aria-hidden="true"]')) {
      smallestFontPx = Math.min(smallestFontPx, size);
      if (size < options.minFontPx) smallText.push({ element: describe(element), size });
    }
  }

  const focusable = [...document.querySelectorAll(options.focusableSelector)].filter(visible);
  const targets = focusable.map((element) => {
    const rect = element.getBoundingClientRect();
    return { element: describe(element), width: round(rect.width), height: round(rect.height), name: accessibleName(element) };
  });

  const overflowingElements = [...document.body.querySelectorAll("*")]
    .filter((element) => {
      if (getComputedStyle(element).position === "fixed") return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && (rect.right > root.clientWidth + 1 || rect.left < -1);
    })
    .slice(0, 10)
    .map(describe);

  const landmarkSelector = "header, main, footer, nav, [role=banner], [role=main], [role=contentinfo], [role=navigation], [role=region], [role=status]";
  const topLevel = (selector) => [...document.querySelectorAll(selector)].filter((element) => !element.parentElement.closest("article, aside, main, nav, section")).length;
  const meta = (selector, attribute = "content") => document.querySelector(selector)?.getAttribute(attribute) ?? null;

  return {
    // innerWidth includes a classic scrollbar; clientWidth (used for overflow) does not.
    viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
    horizontalOverflowPx: root.scrollWidth - root.clientWidth,
    overflowingElements,
    contrastFailures,
    smallText,
    smallestFontPx,
    targets,
    headings: [...document.querySelectorAll("h1, h2, h3, h4, h5, h6")].map((heading) => Number(heading.tagName[1])),
    landmarks: {
      banner: topLevel("header"),
      main: document.querySelectorAll("main").length,
      contentinfo: topLevel("footer"),
      unlabeledNavigation: [...document.querySelectorAll("nav")].filter((nav) => !nav.getAttribute("aria-label") && !nav.getAttribute("aria-labelledby")).length,
    },
    textOutsideLandmarks: [...textElements].filter((element) => visible(element) && !element.closest(landmarkSelector) && !element.closest(".kt-skip-link")).map(describe),
    images: [...document.images].map((image) => {
      const rect = image.getBoundingClientRect();
      return {
        src: (image.currentSrc || image.src).replace(location.origin, ""),
        alt: image.getAttribute("alt"),
        attributes: [Number(image.getAttribute("width")), Number(image.getAttribute("height"))],
        rendered: [round(rect.width), round(rect.height)],
      };
    }),
    links: [...document.querySelectorAll("a[href]")].map((anchor) => ({ href: anchor.getAttribute("href"), name: accessibleName(anchor) })),
    mainText: document.querySelector("main")?.innerText ?? "",
    document: {
      lang: root.lang,
      title: document.title,
      description: meta('meta[name="description"]'),
      viewport: meta('meta[name="viewport"]'),
      themeColor: meta('meta[name="theme-color"]'),
      manifest: meta('link[rel="manifest"]', "href"),
      canonical: meta('link[rel="canonical"]', "href"),
    },
  };
}
