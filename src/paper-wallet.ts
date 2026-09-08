import fs from "node:fs";
import path from "node:path";

interface PaperData {
  sol: number;
  positions: Record<string, number>;
  trades: Array<{ at: string; side: "buy" | "sell"; mint: string; tokens: number; sol: number }>;
}

export class PaperWallet {
  constructor(private file: string, private startingSol: number) {}

  balance(): number { return this.load().sol; }
  position(mint: string): number { return this.load().positions[mint] ?? 0; }

  buy(mint: string, sol: number, price: number): { tokens: number; balance: number } {
    if (!Number.isFinite(price) || price <= 0) throw new Error("paper trade price is unavailable");
    const d = this.load();
    if (sol > d.sol) throw new Error(`insufficient paper SOL: need ${sol}, have ${d.sol}`);
    const tokens = sol / price;
    d.sol -= sol;
    d.positions[mint] = (d.positions[mint] ?? 0) + tokens;
    d.trades.push({ at: new Date().toISOString(), side: "buy", mint, tokens, sol });
    this.save(d);
    return { tokens, balance: d.sol };
  }

  sell(mint: string, pct: number, price: number): { tokens: number; sol: number; balance: number } {
    if (!Number.isFinite(price) || price <= 0) throw new Error("paper trade price is unavailable");
    const d = this.load();
    const held = d.positions[mint] ?? 0;
    if (held <= 0) throw new Error("paper wallet holds 0 of this token");
    const tokens = held * Math.min(100, Math.max(1, pct)) / 100;
    const sol = tokens * price;
    d.positions[mint] = held - tokens;
    d.sol += sol;
    d.trades.push({ at: new Date().toISOString(), side: "sell", mint, tokens, sol });
    this.save(d);
    return { tokens, sol, balance: d.sol };
  }

  reset(sol: number): void {
    this.save({ sol, positions: {}, trades: [] });
  }

  summary(): string {
    const d = this.load();
    const positions = Object.entries(d.positions).filter(([, n]) => n > 0);
    return [`Paper SOL: ${d.sol.toFixed(4)}`, `Positions: ${positions.length}`, `Trades: ${d.trades.length}`,
      ...positions.slice(0, 10).map(([m, n]) => `${m.slice(0, 6)}…${m.slice(-4)}: ${n.toPrecision(6)}`)].join("\n");
  }

  private load(): PaperData {
    if (!fs.existsSync(this.file)) return { sol: this.startingSol, positions: {}, trades: [] };
    return JSON.parse(fs.readFileSync(this.file, "utf8")) as PaperData;
  }
  private save(d: PaperData): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(d, null, 2));
  }
}
