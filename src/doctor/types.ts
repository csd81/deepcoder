export type DoctorLevel = "ok" | "warn" | "error";

export interface DoctorFinding {
  id: string;
  section: string;
  level: DoctorLevel;
  title: string;
  details?: string;
  fix?: string;
}

export interface DoctorReport {
  ok: boolean;
  summary: { ok: number; warn: number; error: number };
  findings: DoctorFinding[];
}
