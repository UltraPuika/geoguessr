import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { USAGE_CONFIG } from '../../config/usage-config';
import { UsageMonthRecord } from '../../core/usage-ledger';
import { describeStorageError } from '../../data/db';
import { GoogleMapsLoaderService } from '../../services/google-maps-loader.service';
import { MapUsageService } from '../../services/guess-map.service';
import { ToastService } from '../../services/toast.service';
import { UsageService } from '../../services/usage.service';
import { UsageMeterComponent } from '../../shared/usage-meter.component';
import { formatDate } from '../../shared/util';

@Component({
  selector: 'app-settings',
  imports: [DecimalPipe, FormsModule, UsageMeterComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './settings.component.html',
})
export class SettingsComponent implements OnInit {
  protected readonly usage = inject(UsageService);
  protected readonly mapUsage = inject(MapUsageService);
  protected readonly loader = inject(GoogleMapsLoaderService);
  private readonly toast = inject(ToastService);

  protected readonly config = USAGE_CONFIG;
  protected readonly history = signal<UsageMonthRecord[]>([]);
  protected readonly persisted = signal<boolean | null>(null);
  protected readonly storageEstimate = signal<string | null>(null);
  protected readonly formatDate = formatDate;
  protected manualUnits: number | null = null;

  async ngOnInit(): Promise<void> {
    await this.reload();
    try {
      this.persisted.set((await navigator.storage?.persisted?.()) ?? null);
      const est = await navigator.storage?.estimate?.();
      if (est?.usage !== undefined) {
        const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
        this.storageEstimate.set(`${mb(est.usage)} used${est.quota ? ` of ~${mb(est.quota)} available` : ''}`);
      }
    } catch {
      // Storage API is optional.
    }
  }

  private async reload(): Promise<void> {
    await this.usage.refresh();
    await this.mapUsage.refresh();
    try {
      this.history.set(await this.usage.history());
    } catch {
      this.history.set([]);
    }
  }

  protected async addManual(): Promise<void> {
    const n = Number(this.manualUnits);
    if (!Number.isInteger(n) || n <= 0 || n > 100000) {
      this.toast.error('Enter a whole number greater than zero.');
      return;
    }
    if (!confirm(`Add ${n} unit(s) to this month's counter? This cannot be undone.`)) return;
    try {
      await this.usage.addManualUsage(n);
      this.manualUnits = null;
      await this.reload();
      this.toast.success('Usage counter increased.');
    } catch (err) {
      this.toast.error(describeStorageError(err));
    }
  }

  protected async repair(): Promise<void> {
    const ok = confirm(
      'Rebuild usage tracking assuming the worst case?\n\nThis month will be marked as fully used, so Street View ' +
        'stays blocked until the next monthly reset. Maps and history are not affected.',
    );
    if (!ok) return;
    try {
      await this.usage.repair();
      await this.reload();
      this.toast.success('Usage tracking rebuilt conservatively.');
    } catch (err) {
      this.toast.error(describeStorageError(err));
    }
  }

  protected async repairMaps(): Promise<void> {
    if (!confirm('Rebuild the Google map counter? This month is marked as used up and the free map is used until the reset.')) {
      return;
    }
    try {
      await this.mapUsage.repair();
      this.toast.success('Map counter rebuilt.');
    } catch (err) {
      this.toast.error(describeStorageError(err));
    }
  }

  protected async requestPersist(): Promise<void> {
    try {
      this.persisted.set((await navigator.storage?.persist?.()) ?? false);
    } catch {
      this.persisted.set(false);
    }
  }
}
