import type BpmnModeler from 'bpmn-js/lib/Modeler';
import type { LegendEntry } from './types';
import { DEFAULT_LEGEND } from './types';

export function cloneLegend(legend?: LegendEntry[] | null): LegendEntry[] {
  const source =
    legend && legend.length > 0 ? legend : DEFAULT_LEGEND;
  return source.map((entry) => ({ ...entry }));
}

export function applyElementColor(
  modeler: BpmnModeler,
  fill: string,
  stroke?: string
): boolean {
  const selection = modeler.get('selection') as {
    get: () => Array<{ id: string; businessObject?: unknown }>;
  };
  const modeling = modeler.get('modeling') as {
    setColor: (
      elements: unknown[],
      colors: { fill?: string; stroke?: string }
    ) => void;
  };

  const selected = selection.get().filter((el) => {
    const type = (el as { type?: string }).type ?? '';
    return type && !type.includes('Label') && type !== 'bpmn:Process';
  });

  if (selected.length === 0) {
    return false;
  }

  modeling.setColor(selected, {
    fill,
    stroke: stroke ?? darkenHex(fill),
  });
  return true;
}

function darkenHex(hex: string): string {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim());
  if (!match) {
    return '#334155';
  }
  const channels = match.slice(1, 4).map((part) => {
    const value = Math.max(0, Math.floor(parseInt(part, 16) * 0.55));
    return value.toString(16).padStart(2, '0');
  });
  return `#${channels.join('')}`;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(href);
}

export async function exportSvg(
  modeler: BpmnModeler,
  filename: string
): Promise<void> {
  const { svg } = await modeler.saveSVG();
  if (!svg) {
    throw new Error('SVG vazio');
  }
  downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), filename);
}

export async function exportPng(
  modeler: BpmnModeler,
  filename: string,
  scale = 2
): Promise<void> {
  const { svg } = await modeler.saveSVG();
  if (!svg) {
    throw new Error('SVG vazio');
  }

  const blob = await svgToPngBlob(svg, scale);
  downloadBlob(blob, filename);
}

async function svgToPngBlob(svg: string, scale: number): Promise<Blob> {
  const { width, height } = parseSvgSize(svg);
  const svgBlob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(svgBlob);

  try {
    const image = await loadImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(width * scale));
    canvas.height = Math.max(1, Math.ceil(height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Canvas não disponível');
    }
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (result) => {
          if (result) {
            resolve(result);
          } else {
            reject(new Error('Falha ao gerar PNG'));
          }
        },
        'image/png'
      );
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function parseSvgSize(svg: string): { width: number; height: number } {
  const viewBox = /viewBox=["']([^"']+)["']/i.exec(svg);
  if (viewBox) {
    const parts = viewBox[1].trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
      return {
        width: Math.max(1, parts[2]),
        height: Math.max(1, parts[3]),
      };
    }
  }

  const widthMatch = /width=["']([\d.]+)/i.exec(svg);
  const heightMatch = /height=["']([\d.]+)/i.exec(svg);
  return {
    width: Math.max(1, Number(widthMatch?.[1] ?? 800)),
    height: Math.max(1, Number(heightMatch?.[1] ?? 600)),
  };
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Falha ao carregar SVG'));
    image.src = url;
  });
}
