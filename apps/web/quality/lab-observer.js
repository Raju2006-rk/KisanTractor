// Installed before any page script (Page.addScriptToEvaluateOnNewDocument).
// Records lab web-vital inputs into window.__ktLab using the same entry types
// the web-vitals library reads: LCP, layout shifts in session windows (CLS),
// long tasks (for Total Blocking Time), first contentful paint, and event
// timing entries grouped by interaction (for an INP-style measurement).
(() => {
  const lab = { lcp: null, lcpElement: null, cls: 0, shifts: [], fcp: null, longTasks: [], events: [] };
  Object.defineProperty(window, "__ktLab", { value: lab });
  const describe = (element) => {
    if (!element) return null;
    const classes = typeof element.className === "string" && element.className ? `.${element.className.trim().split(/\s+/).join(".")}` : "";
    const source = element.currentSrc ? ` ${element.currentSrc.replace(location.origin, "")}` : "";
    return `${element.tagName.toLowerCase()}${classes}${source}`;
  };
  const observe = (type, callback, options) => {
    try {
      new PerformanceObserver((list) => list.getEntries().forEach(callback)).observe({ type, buffered: true, ...options });
    } catch {
      // Entry type unsupported in this browser; the suite reports the gap.
    }
  };
  observe("largest-contentful-paint", (entry) => {
    lab.lcp = entry.startTime;
    lab.lcpElement = describe(entry.element);
  });
  let sessionValue = 0;
  let sessionStart = 0;
  let previous = -Infinity;
  observe("layout-shift", (entry) => {
    if (entry.hadRecentInput) return;
    if (entry.startTime - previous > 1000 || entry.startTime - sessionStart > 5000) {
      sessionValue = 0;
      sessionStart = entry.startTime;
    }
    sessionValue += entry.value;
    previous = entry.startTime;
    lab.cls = Math.max(lab.cls, sessionValue);
    lab.shifts.push({ at: entry.startTime, value: entry.value, sources: (entry.sources || []).map((source) => describe(source.node)) });
  });
  observe("paint", (entry) => {
    if (entry.name === "first-contentful-paint") lab.fcp = entry.startTime;
  });
  observe("longtask", (entry) => lab.longTasks.push({ start: entry.startTime, duration: entry.duration }));
  observe("event", (entry) => {
    if (entry.interactionId) lab.events.push({ name: entry.name, duration: entry.duration, interactionId: entry.interactionId });
  }, { durationThreshold: 16 });
})();
