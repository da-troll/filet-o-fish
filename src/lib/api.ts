import type { Anlegg, Eier } from "../types";

// Upstream latency is ~linear in page size: limit=50 ≈ 7s, limit=200 ≈ 20s,
// limit=500 ≈ 42s. Smaller pages = rows on screen sooner. Ramp up so the
// first few waves feel fast, then settle at 200 for throughput.
export const FIRST_PAGE_SIZE = 50;
export const BULK_PAGE_SIZE = 200;
// Upstream throttles hard beyond 2 in-flight requests: individual latency
// balloons from ~9s to ~30s with 4 concurrent. 2 gives the best throughput.
export const PARALLEL_CONCURRENCY = 2;

// Page-size schedule AFTER the first (50) page: 100×3, 150×3, then 200 forever.
// Rows stream in at an accelerating cadence — user perceives continuous motion
// rather than a jump from 50 → 200.
const RAMP: number[] = [100, 100, 100, 150, 150, 150];

export function pageSizeForIndex(i: number): number {
  return i < RAMP.length ? RAMP[i] : BULK_PAGE_SIZE;
}

/** Stripped-down anlegg shape from upstream — sykdomstilfeller embedded summary
 * is dropped at parse time; we get richer data from the rapporteringer endpoint. */
export type AnleggBase = Omit<Anlegg, "sykdomstilfeller" | "arter"> & {
  /** Raw eiere preserved as-is */
  eiere: Eier[];
};

export interface AnleggPage {
  items: AnleggBase[];
  total: number | null;
}

export async function fetchAnleggPage(offset: number, limit: number): Promise<AnleggPage> {
  // fiskehelseregisteret/v1/anlegg left the open API (401, Maskinporten only); helsestatus/v2/lokaliteter has the
  // same localities: lokalitetsnummer is the anleggId the cases join on, virksomheter are the owners (HIVE-1438).
  const url = `/api/helsestatus/v2/lokaliteter?limit=${limit}&offset=${offset}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  type Raw = { lokalitetsnummer: number; lokalitetsnavn: string; produksjonsformer?: string[]; virksomheter?: Eier[] };
  const raw = (await res.json()) as Raw[];
  const items: AnleggBase[] = raw.map((a) => ({
    anleggId: a.lokalitetsnummer,
    anleggNavn: a.lokalitetsnavn,
    produksjonsform: a.produksjonsformer ?? [],
    eiere: (a.virksomheter ?? []).map(({ id, navn }) => ({ id, navn })),
  }));
  const totalHeader = res.headers.get("x-count");
  const total = totalHeader ? Number(totalHeader) : null;
  return { items, total: Number.isFinite(total) ? total : null };
}

interface ReportRaw {
  id: string;
  opprettet: string;
  oppdatert: string;
  lokalitetsnummer?: number;
  lokalitetsnavn: string;
  varslingsdato: string;
  oppdrettersMistankedato: string | null;
  kvalitetssikretMistankedato: string | null;
  diagnosedato: string | null;
  avslutningsdato: string | null;
  avslutningsårsak: string | null;
  ugyldiggjøringsdato: string | null;
  sykdomstype: string;
  sykdomssubtype: string | null;
  arter: Array<{ artskode: string }>;
}

/** Fetch all sykdomstilfeller reports — dataset is small (~200 records) so
 * one big page is fine. */
export async function fetchAllReports(): Promise<ReportRaw[]> {
  const url = `/api/sykdomstilfeller/v1/rapporteringer?limit=1000&offset=0`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as ReportRaw[];
}
