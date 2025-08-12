// @ts-nocheck
import React, { useMemo, useRef, useState, useEffect } from "react";
import { motion } from "framer-motion";
import Papa from "papaparse";
import { format, isValid, parse as parseDateFns } from "date-fns";
import { pl } from "date-fns/locale";
import {
  Upload,
  Search,
  ZoomIn,
  ZoomOut,
  RefreshCcw,
  Clock,
  CalendarDays,
  Info,
  X,
  Download,
  FileDown,
  ImageDown,
  Moon,
  Sun
} from "lucide-react";
import * as htmlToImage from "html-to-image";
import { jsPDF } from "jspdf";

/**
 * Gantt – Marszruta po ID + Połączenia + Ciemny motyw + Sticky + Filtr maszyn
 *  • lane'y (tory) dla nakładających się zleceń na maszynie
 *  • czytelna oś (data+godzina, dzienne linie pogrubione)
 *  • zakres czasu: ręcznie + presety Dziś / 7 dni / 30 dni
 *  • wpisanie pełnego "Order No." zwęża widok do marszruty + rysuje połączenia
 *  • auto‑wysokość paska (ID + Qty.)
 *  • eksport PNG / PDF / CSV (dla aktualnego widoku)
 *  • CIEMNY MOTYW (przełącznik) + sticky: toolbar, pasek filtrów, pasek czasu i panel maszyn
 *  • FILTR MASZYN: szukaj + multi‑select (pokaż tylko wybrane)
 *  • CTRL + kółko myszy nad wykresem = zoom do miejsca kursora
 *  • Kliknięcie paska = pływające okno ze szczegółami przy pasku (Esc lub X zamyka)
 */

// ===== Daty =====
function toDate(val) {
  if (val instanceof Date) return val;
  if (typeof val === "number") {
    if (val < 10_000_000_000) return new Date(val * 1000);
    return new Date(val);
  }
  if (typeof val === "string") {
    const d1 = new Date(val);
    if (!isNaN(d1.getTime())) return d1;
    const fmts = [
      "dd.MM.yyyy HH:mm",
      "dd.MM.yyyy H:mm",
      "dd.MM.yyyy",
      "yyyy-MM-dd HH:mm",
      "yyyy-MM-dd H:mm",
      "yyyy/MM/dd HH:mm",
      "yyyy/MM/dd",
      "dd/MM/yyyy HH:mm",
      "dd/MM/yyyy",
    ];
    for (const f of fmts) {
      const d = parseDateFns(val, f, new Date(), { locale: pl });
      if (isValid(d)) return d;
    }
  }
  return null;
}
function formatPL(d) {
  try { return format(d, "dd.MM.yyyy HH:mm", { locale: pl }); } catch { return "—"; }
}
function toInputLocal(d) {
  const pad = (n) => String(n).padStart(2, "0");
  const y = d.getFullYear();
  const m = pad(d.getMonth()+1);
  const day = pad(d.getDate());
  const h = pad(d.getHours());
  const min = pad(d.getMinutes());
  return `${y}-${m}-${day}T${h}:${min}`;
}

// ===== Kolumny =====
const matchers = {
  id: [/^order\s*no\.?$/i, /^id$/i, /^order(_)?id$/i, /^zlecenie$/i, /^nr(zlecenia)?$/i],
  start: [/^start\s*time$/i, /^start(\s|_)?(time)?$/i, /^poczatek$/i, /^data(\s|_)?startu$/i, /^from$/i],
  end: [/^end\s*time$/i, /^end(\s|_)?(time)?$/i, /^koniec$/i, /^data(\s|_)?konca$/i, /^to$/i],
  resource: [/^resource$/i, /^maszyna$/i, /^maszyny$/i, /^machine$/i, /^gniazdo$/i, /^stanowisko$/i],
  qty: [/^qty\.?$/i, /^ilosc$/i, /^quantity$/i],
};
function detectColumn(headers, type) {
  const regs = matchers[type] || [];
  for (const r of regs) {
    const found = headers.find((h) => r.test(String(h)));
    if (found) return found;
  }
  return null;
}

// ===== Lane packing =====
function packLanes(tasks) {
  const laneEnds = [];
  const placed = [];
  const EPS = 60_000; // 1 min
  const sorted = [...tasks].sort((a, b) => +a.start - +b.start);
  for (const t of sorted) {
    let lane = -1;
    for (let i = 0; i < laneEnds.length; i++) {
      if (+t.start >= laneEnds[i] - EPS) { lane = i; break; }
    }
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(+t.end); }
    else { laneEnds[lane] = +t.end; }
    placed.push({ ...t, lane });
  }
  return { placed, laneCount: laneEnds.length || 1 };
}

export default function App() {
  // ===== Ustawienia/motyw =====
  const [dark, setDark] = useState(true); // domyślnie CIEMNY

  // ===== Dane =====
  const [rawRows, setRawRows] = useState([]);
  const [mapping, setMapping] = useState({ id: null, start: null, end: null, resource: null, qty: null });

  const [query, setQuery] = useState(""); // wyszukiwanie po ID (Order No.)
  const [pxPerHour, setPxPerHour] = useState(110);
  const [selected, setSelected] = useState(null);

  // Popover szczegółów
  const [popover, setPopover] = useState(null); // {task, x, y, side}
  const popRef = useRef(null);
  // Refs scroll/obszar treści
  const scrollRef = useRef(null);
  const contentRef = useRef(null);
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") setPopover(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Filtr maszyn
  const [machineQ, setMachineQ] = useState("");
  const [selectedMachines, setSelectedMachines] = useState(() => new Set()); // multi‑select

  // zakres czasu
  const [fromStr, setFromStr] = useState("");
  const [toStr, setToStr] = useState("");
  const timeFrom = fromStr ? toDate(fromStr) : null;
  const timeTo = toStr ? toDate(toStr) : null;

  // export & exportRef
  const exportRef = useRef(null);

  // ====== Zoom: CTRL + kółko nad wykresem ======
  const handleWheel = (e) => {
    if (!e.ctrlKey || !scrollRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    const container = scrollRef.current;
    const rect = container.getBoundingClientRect();
    const xRel = e.clientX - rect.left; // pozycja kursora w kontenerze (bez scrollLeft)
    const x = xRel + container.scrollLeft; // pozycja względem całej szerokości wykresu

    // kotwica czasowa pod kursorem
    const pxPerMsCurrent = (pxPerHour || 1) / 3_600_000;
    const anchorTime = computedMinMax.min + x / pxPerMsCurrent;

    // nowy zoom
    const factor = e.deltaY > 0 ? 0.9 : 1.1; // krok ~10%
    const next = Math.max(30, Math.min(300, Math.round(pxPerHour * factor)));
    if (next === pxPerHour) return;

    const pxPerMsNext = next / 3_600_000;
    const anchorXNext = (anchorTime - computedMinMax.min) * pxPerMsNext; // gdzie powinien wypaść anchor po zmianie
    const newScrollLeft = Math.max(0, anchorXNext - xRel);
    setPxPerHour(next);
    // ustawienie scrollLeft natychmiast (bez czekania na render)
    container.scrollLeft = newScrollLeft;
  };

  // CSV
  const onFile = (file) => {
    if (!file) return;
    Papa.parse(file, {
      header: true,
      dynamicTyping: true,
      skipEmptyLines: true,
      complete: (res) => {
        const data = (res.data || []).filter(Boolean);
        setRawRows(data);
        const headers = res.meta?.fields || Object.keys(data[0] || {});
        const map = new Map(headers.map((h) => [String(h).toLowerCase(), h]));
        const pick = (wanted, type) => map.get(String(wanted).toLowerCase()) || detectColumn(headers, type);
        setMapping({
          id: pick("Order No.", "id"),
          start: pick("Start Time", "start"),
          end: pick("End Time", "end"),
          resource: pick("Resource", "resource"),
          qty: pick("Qty.", "qty"),
        });
      },
      error: (e) => alert("Błąd wczytywania CSV: " + e?.message),
    });
  };

  // Tasks
  const allTasks = useMemo(() => {
    if (!rawRows.length || !mapping.id || !mapping.start || !mapping.end || !mapping.resource) return [];
    const out = [];
    for (const r of rawRows) {
      const id = String(r[mapping.id] ?? "").trim();
      const resource = String(r[mapping.resource] ?? "").trim();
      const start = toDate(r[mapping.start]);
      const end = toDate(r[mapping.end]);
      if (!id || !resource || !start || !end || +end <= +start) continue;
      const qty = mapping.qty ? Number(r[mapping.qty]) : null;
      out.push({ id, resource, start, end, qty, _raw: r });
    }
    return out.sort((a, b) => a.resource.localeCompare(b.resource, "pl", { numeric: true }) || +a.start - +b.start || a.id.localeCompare(b.id, "pl", { numeric: true }));
  }, [rawRows, mapping]);

  // Maszyny
  const machinesAll = useMemo(() => {
    const set = new Set(allTasks.map((t) => t.resource));
    return Array.from(set).sort((a, b) => a.localeCompare(b, "pl", { numeric: true }));
  }, [allTasks]);

  // lista po wyszukiwaniu
  const machinesList = useMemo(() => {
    if (!machineQ) return machinesAll;
    const q = machineQ.toLowerCase();
    return machinesAll.filter((m) => m.toLowerCase().includes(q));
  }, [machinesAll, machineQ]);

  // marszruta po Order No.
  const routeTasks = useMemo(() => {
    const q = query.trim();
    if (!q) return [];
    const exact = allTasks.filter((t) => t.id.toLowerCase() === q.toLowerCase());
    if (exact.length) return exact.slice().sort((a,b)=> +a.start-+b.start);
    const part = allTasks.filter((t) => t.id.toLowerCase().includes(q.toLowerCase()));
    return part.slice().sort((a,b)=> +a.start-+b.start);
  }, [allTasks, query]);

  // Filtrowanie widoku — jeśli jest marszruta, ona ma priorytet
  const filtered = useMemo(() => {
    const intersects = (t) => {
      if (timeFrom && +t.end <= +timeFrom) return false;
      if (timeTo && +t.start >= +timeTo) return false;
      return true;
    };
    let base = routeTasks.length ? routeTasks : allTasks;
    // filtr maszyn (multi‑select)
    if (selectedMachines.size > 0) {
      base = base.filter((t) => selectedMachines.has(t.resource));
    }
    // brak marszruty: opcjonalnie pełnotekstowe po ID
    if (!routeTasks.length && query) {
      base = base.filter((t) => t.id.toLowerCase().includes(query.toLowerCase()));
    }
    return base.filter(intersects);
  }, [allTasks, routeTasks, query, selectedMachines, timeFrom, timeTo]);

  // Lane'y i layout per maszyna
  const baseLane = 26; // min wysokość paska
  const laneGap = 6;
  const rowPadY = 10;
  const pxPerMs = useMemo(() => (pxPerHour || 1) / 3_600_000, [pxPerHour]);

  const lanedByMachine = useMemo(() => {
    const map = new Map();
    const groups = new Map();
    for (const t of filtered) { if (!groups.has(t.resource)) groups.set(t.resource, []); groups.get(t.resource).push(t); }
    for (const [res, arr] of groups) {
      const { placed } = packLanes(arr);
      const laneHeights = [];
      for (const p of placed) {
        const w = Math.max(4, (+p.end - +p.start) * pxPerMs);
        const h = w > 220 ? 40 : w > 120 ? 32 : baseLane;
        laneHeights[p.lane] = Math.max(laneHeights[p.lane] || baseLane, h);
      }
      const laneTops = [];
      let acc = rowPadY;
      for (let i = 0; i < (laneHeights.length || 1); i++) { laneTops[i] = acc; acc += (laneHeights[i] || baseLane) + laneGap; }
      const totalHeight = acc - laneGap + rowPadY;
      map.set(res, { tasks: placed, laneHeights, laneTops, totalHeight });
    }
    return map;
  }, [filtered, pxPerMs]);

  // Które maszyny renderować
  const routeMachines = useMemo(() => Array.from(new Set(routeTasks.map((t) => t.resource))), [routeTasks]);
  const machinesToRender = useMemo(() => {
    if (routeTasks.length) return routeMachines;
    if (selectedMachines.size > 0) return Array.from(selectedMachines).filter((m) => machinesAll.includes(m));
    return machinesAll;
  }, [machinesAll, selectedMachines, routeTasks, routeMachines]);

  // wysokości i topy rzędów
  const rowHeights = useMemo(() => {
    const m = new Map();
    for (const r of machinesToRender) {
      const h = lanedByMachine.get(r)?.totalHeight || (rowPadY*2 + baseLane);
      m.set(r, h);
    }
    return m;
  }, [machinesToRender, lanedByMachine]);

  const rowTops = useMemo(() => {
    const map = new Map();
    let y = 0;
    for (const r of machinesToRender) { map.set(r, y); y += rowHeights.get(r) || (rowPadY*2+baseLane); }
    return map;
  }, [machinesToRender, rowHeights]);

  // Zakres osi czasu (auto przy marszrucie)
  const computedMinMax = useMemo(() => {
    const addMargin = (mm) => ({ min: mm.min - 60*60*1000, max: mm.max + 60*60*1000 });
    const src = filtered.length ? filtered : allTasks;
    if (!src.length) {
      const baseFrom = timeFrom ? +timeFrom : Date.now() - 12 * 3600_000;
      const baseTo = timeTo ? +timeTo : Date.now() + 12 * 3600_000;
      return { min: baseFrom, max: baseTo };
    }
    let min = +src[0].start, max = +src[0].end;
    for (const t of src) { if (+t.start < min) min = +t.start; if (+t.end > max) max = +t.end; }
    if (timeFrom) min = Math.min(min, +timeFrom);
    if (timeTo) max = Math.max(max, +timeTo);
    return addMargin({ min, max });
  }, [filtered, allTasks, timeFrom, timeTo]);

  const totalWidth = Math.max(800, Math.round((computedMinMax.max - computedMinMax.min) * pxPerMs));

  // Ticks
  const minorTicks = useMemo(() => {
    const out = []; const step = 3_600_000; const first = Math.ceil(computedMinMax.min / step) * step; for (let t = first; t <= computedMinMax.max; t += step) out.push(t); return out;
  }, [computedMinMax]);
  const majorTicks = useMemo(() => {
    const out = []; const step = 24 * 3_600_000; const d0 = new Date(computedMinMax.min); d0.setHours(0,0,0,0); let t = d0.getTime(); if (t < computedMinMax.min) t += step; for (; t <= computedMinMax.max; t += step) out.push(t); return out;
  }, [computedMinMax]);

  const leftPaneWidth = 300;
  const now = Date.now();
  const showNow = now >= computedMinMax.min && now <= computedMinMax.max;

  const colorFor = (resource) => { let h = 0; for (let i=0;i<resource.length;i++) h=(h*31+resource.charCodeAt(i))%360; return `hsl(${h} 70% 45%)`; };

  // Presety zakresu
  const setToday = () => { const d0=new Date(); d0.setHours(0,0,0,0); const d1=new Date(d0); d1.setDate(d1.getDate()+1); setFromStr(toInputLocal(d0)); setToStr(toInputLocal(d1)); };
  const set7Days = () => { const d0=new Date(); d0.setHours(0,0,0,0); const d1=new Date(d0); d1.setDate(d1.getDate()+7); setFromStr(toInputLocal(d0)); setToStr(toInputLocal(d1)); };
  const set30Days = () => { const d0=new Date(); d0.setHours(0,0,0,0); const d1=new Date(d0); d1.setDate(d1.getDate()+30); setFromStr(toInputLocal(d0)); setToStr(toInputLocal(d1)); };

  // Eksport
  const download = (blob, filename) => { const url=URL.createObjectURL(blob); const a=document.createElement("a"); a.href=url; a.download=filename; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000); };
  const exportPNG = async () => {
    if (!exportRef.current) return;
    const node = exportRef.current;
    const totalHeight = Array.from(node.querySelectorAll('[data-row-total="1"]')).reduce((s, el) => s + el.getBoundingClientRect().height, 0) + 120;
    const dataUrl = await htmlToImage.toPng(node, { width: leftPaneWidth + totalWidth, height: totalHeight, pixelRatio: 2, backgroundColor: dark ? "#0a0a0a" : "#ffffff" });
    const blob = await (await fetch(dataUrl)).blob();
    download(blob, `plan_${format(new Date(),'yyyy-MM-dd_HH-mm')}.png`);
  };
  const exportPDF = async () => {
    if (!exportRef.current) return;
    const node = exportRef.current;
    const totalHeight = Array.from(node.querySelectorAll('[data-row-total="1"]')).reduce((s, el) => s + el.getBoundingClientRect().height, 0) + 120;
    const dataUrl = await htmlToImage.toPng(node, { width: leftPaneWidth + totalWidth, height: totalHeight, pixelRatio: 2, backgroundColor: dark ? "#0a0a0a" : "#ffffff" });
    const img = new Image(); img.src = dataUrl; await new Promise((r)=>img.onload=r);
    const pdf = new jsPDF({ orientation: "landscape", unit: "px", format: [img.width, img.height] });
    pdf.addImage(img, "PNG", 0, 0, img.width, img.height); pdf.save(`plan_${format(new Date(),'yyyy-MM-dd_HH-mm')}.pdf`);
  };
  const exportCSV = () => {
    const rows = filtered.map((t) => [t.id, t.resource, formatPL(t.start), formatPL(t.end), t.qty ?? "", Math.round((+t.end - +t.start)/60000)]);
    const header = ["Order No.", "Resource", "Start Time", "End Time", "Qty.", "Duration (min)"];
    const csv = [header, ...rows].map((r) => r.map((x) => (x!==null&&x!==undefined?String(x).replace(/\"/g,'""'):"" )).join(",")).join("\n");
    download(new Blob(["\uFEFF"+csv],{type:"text/csv;charset=utf-8"}), `plan_${format(new Date(),'yyyy-MM-dd_HH-mm')}.csv`);
  };

  // ===== Połączenia marszruty (overlay) =====
  const contentHeight = useMemo(() => {
    let sum = 0; for (const r of machinesToRender) sum += rowHeights.get(r) || (rowPadY*2+baseLane); return sum;
  }, [machinesToRender, rowHeights]);

  const routeRects = useMemo(() => {
    if (!routeTasks.length) return [];
    const rects = [];
    for (const t of routeTasks) {
      const layout = lanedByMachine.get(t.resource);
      if (!layout) continue;
      const placed = layout.tasks.find((p) => p.id === t.id && p.resource === t.resource && +p.start === +t.start && +p.end === +t.end);
      const lane = placed?.lane ?? 0;
      const left = (+t.start - computedMinMax.min) * pxPerMs;
      const width = Math.max(4, (+t.end - +t.start) * pxPerMs);
      const barH = layout.laneHeights[lane] || baseLane;
      const top = (rowTops.get(t.resource) || 0) + (layout.laneTops[lane] || rowPadY);
      rects.push({ id: t.id, resource: t.resource, start: +t.start, end: +t.end, left, top, width, height: barH });
    }
    rects.sort((a,b)=>a.start-b.start);
    return rects;
  }, [routeTasks, lanedByMachine, computedMinMax, pxPerMs, rowTops]);

  // ===== UI =====
  const cls = (light, darkCls) => (dark ? darkCls : light);
  const borderBase = cls("border-neutral-200", "border-neutral-800");
  const cardBase = cls("bg-white", "bg-neutral-900");
  const pageBase = cls("bg-neutral-50 text-neutral-900", "bg-neutral-950 text-neutral-100");
  const subtleText = cls("text-neutral-600", "text-neutral-400");
  const headerBg = cls("bg-white/95", "bg-neutral-950/95");
  const subHeaderBg = cls("bg-white/92", "bg-neutral-900/92");
  const gridMinor = cls("border-neutral-100", "border-neutral-800/70");
  const gridMajor = cls("border-neutral-200", "border-neutral-700");
  const timeLabel = cls("text-neutral-800", "text-neutral-200");
  const nowColor = dark ? "#f87171" : "#b91c1c";
  const connectColor = dark ? "#f97316" : "#dc2626"; // pomarańcz na ciemnym lepszy

  // helper do otwarcia popovera w pobliżu paska
  const openPopover = (task, leftPx, topPx, widthPx) => {
    const container = scrollRef.current;
    if (!container) return;
    const viewLeft = container.scrollLeft;
    const viewRight = viewLeft + container.clientWidth;
    let x = leftPx + widthPx + 12; // domyślnie po prawej stronie paska
    let side = "right";
    if (x + 320 > viewRight) { // jeżeli zabraknie miejsca z prawej, pokaż po lewej
      x = leftPx - 12;
      side = "left";
    }
    const y = Math.max(8, topPx - 4);
    setPopover({ task, x, y, side });
  };

  return (
    <div className={`w-full min-h-screen ${pageBase}`}>
      {/* Toolbar (sticky) */}
      <div className={`sticky top-0 z-50 w-full ${borderBase} border-b ${headerBg} backdrop-blur`}>
        <div className="mx-auto max-w-7xl px-4 py-3 flex flex-wrap gap-3 items-center">
          <div className="flex items-center gap-2 text-sm font-medium"><CalendarDays className="w-4 h-4"/> Plan produkcyjny — Gantt</div>

          <label className="inline-flex items-center gap-2 cursor-pointer text-sm ml-auto">
            <input type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
            <span className={`inline-flex items-center gap-2 rounded-xl ${borderBase} border px-3 py-2 hover:opacity-90`}><Upload className="w-4 h-4"/> Załaduj CSV</span>
          </label>

          <button className={`inline-flex items-center gap-2 rounded-xl ${borderBase} border px-3 py-2 hover:opacity-90`} onClick={() => {
            const demo = `Order No.,Product,Part No.,Qty.,Op. No.,Resource,Resource Group Name,Start Time,End Time\n`+
              `3260996,Przykład A,Q-STA,25,10,10ZM4,GRP,10.01.2025 08:00,10.01.2025 16:00\n`+
              `3260996,Przykład A,Q-STA,25,20,10411/1,GRP,11.01.2025 06:00,12.01.2025 14:00\n`+
              `3260996,Przykład A,Q-STA,25,30,10431/2,GRP,12.01.2025 15:00,13.01.2025 10:00`;
            Papa.parse(demo, { header: true, dynamicTyping: true, complete: (res) => {
              setRawRows(res.data); setMapping({ id: "Order No.", start: "Start Time", end: "End Time", resource: "Resource", qty: "Qty." }); setQuery("3260996");
            }});
          }}><RefreshCcw className="w-4 h-4"/> Demo</button>

          <div className={`flex items-center gap-2 rounded-xl ${borderBase} border px-2 py-1`}>
            <Search className="w-4 h-4 opacity-60"/>
            <input className={`outline-none text-sm bg-transparent w-48`} placeholder="Szukaj po Order No.… (auto: marszruta)" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>

          <div className={`flex items-center gap-2 rounded-xl ${borderBase} border px-2 py-1`}>
            <ZoomOut className="w-4 h-4"/>
            <input type="range" min={30} max={300} value={pxPerHour} onChange={(e) => setPxPerHour(parseInt(e.target.value || "110", 10))} />
            <ZoomIn className="w-4 h-4"/>
            <span className="text-xs tabular-nums px-1">{pxPerHour} px/h</span>
          </div>

          {/* Presety zakresu */}
          <div className={`flex items-center gap-2 rounded-xl ${borderBase} border px-2 py-1`}>
            <span className={`text-xs ${subtleText}`}>Zakres:</span>
            <button className={`text-xs px-2 py-1 rounded ${borderBase} border hover:opacity-90`} onClick={setToday}>Dziś</button>
            <button className={`text-xs px-2 py-1 rounded ${borderBase} border hover:opacity-90`} onClick={set7Days}>7 dni</button>
            <button className={`text-xs px-2 py-1 rounded ${borderBase} border hover:opacity-90`} onClick={set30Days}>30 dni</button>
            <input type="datetime-local" value={fromStr} onChange={(e) => setFromStr(e.target.value)} className={`text-xs ${borderBase} border rounded px-1 py-0.5 ml-1 bg-transparent`} />
            <span className="text-xs">–</span>
            <input type="datetime-local" value={toStr} onChange={(e) => setToStr(e.target.value)} className={`text-xs ${borderBase} border rounded px-1 py-0.5 bg-transparent`} />
            {(fromStr || toStr) && (
              <button className={`text-xs inline-flex items-center gap-1 hover:opacity-90`} onClick={() => { setFromStr(""); setToStr(""); }}>
                <X className="w-3 h-3"/> Wyczyść
              </button>
            )}
          </div>

          {/* Eksport */}
          <div className={`flex items-center gap-2 rounded-xl ${borderBase} border px-2 py-1`}>
            <button className="text-xs inline-flex items-center gap-1" onClick={() => exportPNG()}><ImageDown className="w-4 h-4"/> PNG</button>
            <button className="text-xs inline-flex items-center gap-1" onClick={() => exportPDF()}><FileDown className="w-4 h-4"/> PDF</button>
            <button className="text-xs inline-flex items-center gap-1" onClick={() => exportCSV()}><Download className="w-4 h-4"/> CSV</button>
          </div>

          {/* Motyw */}
          <button onClick={() => setDark((v) => !v)} className={`inline-flex items-center gap-2 rounded-xl ${borderBase} border px-3 py-2`} title="Przełącz motyw">
            {dark ? (<><Sun className="w-4 h-4"/> Jasny</>) : (<><Moon className="w-4 h-4"/> Ciemny</>)}
          </button>

          <div className={`text-xs flex items-center gap-1 ${subtleText}`}><Info className="w-4 h-4"/> Daty w lokalnej strefie czasowej.</div>
        </div>
      </div>

      {/* Sticky pasek filtrów maszyn */}
      <div className={`sticky top-[56px] z-40 w-full ${subHeaderBg} ${borderBase} border-b`}>
        <div className="mx-auto max-w-7xl px-4 py-2 flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium mr-1">Maszyny:</span>
          <div className={`flex items-center gap-2 ${borderBase} border rounded-xl px-2 py-1`}>
            <Search className="w-4 h-4 opacity-60"/>
            <input className="bg-transparent outline-none text-sm w-40" placeholder="Szukaj maszyny…" value={machineQ} onChange={(e)=>setMachineQ(e.target.value)} />
          </div>
          <button className={`text-xs px-2 py-1 rounded ${borderBase} border`} onClick={()=>setSelectedMachines(new Set(machinesList))}>Zaznacz widoczne</button>
          <button className={`text-xs px-2 py-1 rounded ${borderBase} border`} onClick={()=>setSelectedMachines(new Set())}>Wyczyść wybór</button>
          {selectedMachines.size>0 && <span className={`text-xs ${subtleText}`}>Wybrane: {selectedMachines.size}</span>}
          <div className="w-full flex flex-wrap gap-2 pt-1">
            {machinesList.map((r)=>{
              const active = selectedMachines.has(r);
              return (
                <button key={r} onClick={()=>{
                  setSelectedMachines((prev)=>{ const s=new Set(prev); if(s.has(r)) s.delete(r); else s.add(r); return s; });
                }} className={`px-3 py-1.5 rounded-full text-xs border transition ${active ? "bg-blue-600 text-white border-blue-600" : `${borderBase} hover:opacity-90`}`}>{r}</button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Główna siatka + połączenia */}
      <div className="mx-auto max-w-[1600px] p-4">
        <div className={`rounded-2xl ${borderBase} border ${cardBase} shadow-sm overflow-hidden`}>
          {/* Obszar eksportu (lewy panel + wykres + overlay linii) */}
          <div ref={exportRef} className="relative">
            {/* Lewy panel (sticky header w panelu) */}
            <div className={`absolute left-0 top-0 bottom-0 ${borderBase} border-r ${cardBase} z-30`} style={{ width: leftPaneWidth }}>
              <div className={`h-16 flex items-center px-3 text-[11px] font-semibold ${subtleText} ${borderBase} border-b sticky top-0 ${cardBase}`}>Maszyna (Resource)</div>
              <div>
                {(machinesToRender.length ? machinesToRender : ["—"]).map((r, idx) => (
                  <div key={r + idx} data-row-total="1" className={`relative flex items-start text-sm ${borderBase} border-b`} style={{ height: (rowHeights.get(r) || (rowPadY*2+baseLane)) }}>
                    <div className="px-3 py-2 truncate" style={{ color: colorFor(r) }}>{r}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Prawy panel (scroll) */}
            <div className="overflow-auto" style={{ marginLeft: leftPaneWidth }} ref={scrollRef} onWheel={handleWheel}>
              {/* Pasek dat (sticky) */}
              <div className={`sticky top-0 z-20 ${borderBase} border-b ${cardBase}`} style={{ width: totalWidth }}>
                <div className="h-16 relative">
                  {majorTicks.map((t) => (<div key={`D${t}`} className={`absolute top-0 bottom-0 ${gridMajor} border-l`} style={{ left: (t - computedMinMax.min) * pxPerMs }} />))}
                  {minorTicks.map((t) => (<div key={t} className={`absolute top-7 bottom-0 ${gridMinor} border-l`} style={{ left: (t - computedMinMax.min) * pxPerMs }} />))}
                  {minorTicks.filter((_, i) => i % 6 === 0).map((t) => (
                    <div key={`L${t}`} className={`absolute -translate-x-1/2 top-0 text-[11px] ${timeLabel}`} style={{ left: (t - computedMinMax.min) * pxPerMs }}>
                      <div className="font-semibold">{format(new Date(t), "dd.MM.yyyy", { locale: pl })}</div>
                      <div className={`text-[10px] ${cls("text-neutral-500","text-neutral-400")}`}>{format(new Date(t), "HH:mm")}</div>
                    </div>
                  ))}
                  {showNow && (
                    <div className="absolute top-0 bottom-0" style={{ left: (now - computedMinMax.min) * pxPerMs }}>
                      <div className="absolute inset-y-0 border-l" style={{ borderColor: nowColor }} />
                      <div className={`absolute -translate-x-1/2 -top-1 text-[10px] px-1 flex items-center gap-1`} style={{ color: nowColor }}><Clock className="w-3 h-3"/> teraz</div>
                    </div>
                  )}
                </div>
              </div>

              {/* treść: rzędy maszyn + paski */}
              <div className="relative" ref={contentRef} style={{ width: totalWidth, height: contentHeight }}>
                {/* siatka godzinowa jako tło */}
                {minorTicks.map((t) => (
                  <div key={`bg${t}`} className={`absolute top-0 bottom-0 ${gridMinor} border-l`} style={{ left: (t - computedMinMax.min) * pxPerMs }} />
                ))}

                {/* paski */}
                {(machinesToRender.length ? machinesToRender : ["—"]).map((r) => {
                  const layout = lanedByMachine.get(r) || { tasks: [], laneTops: [rowPadY], laneHeights: [baseLane] };
                  const baseTop = rowTops.get(r) || 0;
                  const tasks = layout.tasks;
                  return tasks.map((task, i) => {
                    const left = (+task.start - computedMinMax.min) * pxPerMs;
                    const width = Math.max(4, (+task.end - +task.start) * pxPerMs);
                    const barH = layout.laneHeights[task.lane] || baseLane;
                    const top = baseTop + (layout.laneTops[task.lane] || rowPadY);
                    return (
                      <motion.button
                        key={`${task.id}-${task.resource}-${+task.start}-${i}`}
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.2, delay: i * 0.01 }}
                        className={`absolute rounded-lg text-left shadow-sm focus:outline-none focus:ring-2 focus:ring-offset-1 ${dark ? 'focus:ring-offset-neutral-900' : 'focus:ring-offset-white'}`}
                        style={{ left, top, width, height: barH, backgroundColor: colorFor(task.resource), color: "white", padding: "4px 10px" }}
                        title={`${task.id}${(task.qty||task.qty===0)?` (Qty: ${task.qty})`:''} — ${formatPL(task.start)} → ${formatPL(task.end)} | ${task.resource}`}
                        onClick={() => { setSelected(task); openPopover(task, left, top, width); }}
                      >
                        <div className="text-xs font-medium whitespace-nowrap">
                          {barH >= 32 && width >= 80 ? (
                            <>
                              <div className="leading-tight truncate">{task.id}</div>
                              {(task.qty||task.qty===0) && <div className={`leading-tight text-[10px] ${cls('opacity-80','opacity-90')}`}>Qty: {task.qty}</div>}
                            </>
                          ) : (
                            <div className="truncate">{task.id}{(task.qty||task.qty===0)?` · ${task.qty}`:''}</div>
                          )}
                        </div>
                      </motion.button>
                    );
                  });
                })}

                {/* Popover szczegółów przy pasku */}
                {popover && (
                  <div ref={popRef} className="absolute z-50" style={{ left: popover.x, top: popover.y, transform: popover.side === 'left' ? 'translateX(-100%)' : 'none' }}>
                    <div className={`relative w-[320px] rounded-2xl ${borderBase} border ${cardBase} shadow-lg`}> 
                      <button className="absolute -top-2 -right-2 bg-black/50 text-white rounded-full w-6 h-6 flex items-center justify-center" onClick={() => setPopover(null)} title="Zamknij">
                        <X className="w-4 h-4"/>
                      </button>
                      <div className="p-4">
                        <div className="text-sm font-semibold mb-2">Szczegóły zlecenia</div>
                        <div className="text-sm grid grid-cols-3 gap-x-3 gap-y-1">
                          <div className={`${subtleText}`}>ID</div><div className="col-span-2 font-medium">{popover.task.id}</div>
                          <div className={`${subtleText}`}>Maszyna</div><div className="col-span-2" style={{ color: colorFor(popover.task.resource) }}>{popover.task.resource}</div>
                          <div className={`${subtleText}`}>Start</div><div className="col-span-2">{formatPL(popover.task.start)}</div>
                          <div className={`${subtleText}`}>End</div><div className="col-span-2">{formatPL(popover.task.end)}</div>
                          <div className={`${subtleText}`}>Czas</div><div className="col-span-2">{Math.round((+popover.task.end - +popover.task.start)/60000)} min</div>
                          {(popover.task.qty||popover.task.qty===0) && (<><div className={`${subtleText}`}>Qty.</div><div className="col-span-2">{popover.task.qty}</div></>)}
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Overlay z połączeniami marszruty (elbow, dashed) */}
                {routeRects.length >= 2 && (
                  <svg className="absolute inset-0 pointer-events-none" width={totalWidth} height={contentHeight} viewBox={`0 0 ${totalWidth} ${contentHeight}`}>
                    {routeRects.map((r,i)=>{
                      if (i===0) return null;
                      const prev = routeRects[i-1];
                      const x1 = prev.left + prev.width;
                      const y1 = prev.top + prev.height/2;
                      const x2 = r.left;
                      const y2 = r.top + r.height/2;
                      const midX = Math.min(x1 + 30, (x1 + x2)/2);
                      const path = `M ${x1} ${y1} L ${midX} ${y1} L ${midX} ${y2} L ${x2} ${y2}`;
                      return <path key={`c${i}`} d={path} stroke={connectColor} strokeWidth="3" strokeDasharray="6 6" fill="none"/>;
                    })}
                  </svg>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Szczegóły (panel poniżej – zostaje, ale popover daje szybki podgląd) */}
        {selected && (
          <div className="mt-4 grid md:grid-cols-2 gap-4">
            <div className={`rounded-2xl ${borderBase} border ${cardBase} p-4 shadow-sm`}>
              <div className="text-sm font-semibold mb-2">Szczegóły zlecenia</div>
              <div className="text-sm grid grid-cols-3 gap-x-3 gap-y-1">
                <div className={`${subtleText}`}>ID</div><div className="col-span-2 font-medium">{selected.id}</div>
                <div className={`${subtleText}`}>Maszyna</div><div className="col-span-2" style={{ color: colorFor(selected.resource) }}>{selected.resource}</div>
                <div className={`${subtleText}`}>Start</div><div className="col-span-2">{formatPL(selected.start)}</div>
                <div className={`${subtleText}`}>End</div><div className="col-span-2">{formatPL(selected.end)}</div>
                <div className={`${subtleText}`}>Czas</div><div className="col-span-2">{Math.round((+selected.end - +selected.start)/60000)} min</div>
                {(selected.qty||selected.qty===0) && (<><div className={`${subtleText}`}>Qty.</div><div className="col-span-2">{selected.qty}</div></>)}
              </div>
            </div>
            <div className={`rounded-2xl ${borderBase} border ${cardBase} p-4 shadow-sm`}>
              <div className="text-sm font-semibold mb-2">Tipy</div>
              <ul className={`text-sm list-disc pl-5 space-y-1 ${cls('text-neutral-700','text-neutral-300')}`}>
                <li>CTRL + kółko myszy: zoom do miejsca kursora.</li>
                <li>Klik na pasku: szybkie okno ze szczegółami przy pasku (Esc zamyka).</li>
                <li>Sticky: toolbar, pasek filtrów, pasek czasu i panel maszyn pozostają widoczne.</li>
                <li>Użyj wyszukiwarki i przycisków, żeby filtrować maszyny (multi‑select).</li>
              </ul>
            </div>
          </div>
        )}

        {!allTasks.length and (
          <div className={`mt-6 rounded-2xl ${borderBase} border ${cardBase} p-6 shadow-sm text-center text-sm ${subtleText}`}>
            Załaduj CSV (Order No., Resource, Start Time, End Time, opcjonalnie Qty.) lub kliknij <em>Demo</em>.
          </div>
        )}
      </div>

      <div className={`py-8 text-center text-xs ${cls('text-neutral-400','text-neutral-500')}`}>© {new Date().getFullYear()} — Gantt: marszruta + połączenia</div>
    </div>
  );
}
