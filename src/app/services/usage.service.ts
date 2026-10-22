import { Injectable, computed, inject, signal } from '@angular/core';
import { USAGE_CONFIG } from '../config/usage-config';
import { Reservation, ReservationKind, ReserveOutcome, UsageStatus } from '../core/usage-ledger';
import { UsageGate } from '../core/street-view-controller';
import { DatabaseService } from './database.service';

@Injectable({ providedIn: 'root' })
export class UsageService implements UsageGate {
  private readonly repo = inject(DatabaseService).usage;
  private readonly _status = signal<UsageStatus | null>(null);

  readonly status = this._status.asReadonly();
  readonly config = USAGE_CONFIG;
  readonly blocked = computed(() => this._status()?.blocked ?? true);

  async refresh(): Promise<UsageStatus> {
    const s = await this.repo.getStatus();
    this._status.set(s);
    return s;
  }

  async reserve(kind: ReservationKind): Promise<ReserveOutcome> {
    const out = await this.repo.reserve(kind);
    this._status.set(out.status);
    return out;
  }

  async settle(reservation: Reservation, outcome: 'confirmed' | 'failed' | 'released'): Promise<void> {
    try {
      await this.repo.settle(reservation, outcome);
    } finally {
      await this.refresh();
    }
  }

  async addManualUsage(units: number): Promise<void> {
    this._status.set(await this.repo.addManualUsage(units));
  }

  async repair(): Promise<void> {
    this._status.set(await this.repo.repairConservatively());
  }

  history() {
    return this.repo.history();
  }
}
