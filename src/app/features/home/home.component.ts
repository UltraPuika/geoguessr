import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { parseImport } from '../../core/map-io';
import { GAME_MODE_LABELS, GameRecord, MapSummary } from '../../core/models';
import { describeStorageError } from '../../data/db';
import { DatabaseService } from '../../services/database.service';
import { ToastService } from '../../services/toast.service';
import { UsageMeterComponent } from '../../shared/usage-meter.component';
import { downloadJson, formatDate, safeFileName } from '../../shared/util';

type SortKey = 'updated' | 'name' | 'count';

@Component({
  selector: 'app-home',
  imports: [FormsModule, RouterLink, DecimalPipe, UsageMeterComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './home.component.html',
})
export class HomeComponent implements OnInit {
  private readonly db = inject(DatabaseService);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);

  protected readonly maps = signal<MapSummary[] | null>(null);
  protected readonly recent = signal<GameRecord[]>([]);
  protected readonly loadError = signal<string | null>(null);
  protected readonly importErrors = signal<string[]>([]);
  protected readonly busy = signal(false);
  protected readonly search = signal('');
  protected readonly sort = signal<SortKey>('updated');
  protected newName = '';

  protected readonly modeLabels = GAME_MODE_LABELS;
  protected readonly formatDate = formatDate;

  protected readonly visibleMaps = computed(() => {
    const list = this.maps() ?? [];
    const q = this.search().trim().toLowerCase();
    const filtered = q
      ? list.filter((m) => m.name.toLowerCase().includes(q) || m.description.toLowerCase().includes(q))
      : list;
    const sorted = [...filtered];
    switch (this.sort()) {
      case 'name':
        sorted.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case 'count':
        sorted.sort((a, b) => b.locationCount - a.locationCount);
        break;
      default:
        sorted.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }
    return sorted;
  });

  ngOnInit(): void {
    void this.load();
  }

  protected async load(): Promise<void> {
    try {
      this.loadError.set(null);
      const [maps, recent] = await Promise.all([this.db.maps.listMaps(), this.db.history.listGames(5)]);
      this.maps.set(maps);
      this.recent.set(recent);
    } catch (err) {
      this.loadError.set(describeStorageError(err));
      this.maps.set([]);
    }
  }

  protected async create(): Promise<void> {
    const name = this.newName.trim();
    if (!name) return;
    await this.run(async () => {
      const map = await this.db.maps.createMap(name);
      this.newName = '';
      await this.router.navigate(['/maps', map.id]);
    });
  }

  protected async duplicate(m: MapSummary): Promise<void> {
    await this.run(async () => {
      const copy = await this.db.maps.duplicateMap(m.id);
      this.toast.success(`Created "${copy.name}".`);
      await this.load();
    });
  }

  protected async remove(m: MapSummary): Promise<void> {
    const ok = confirm(
      `Delete "${m.name}" and its ${m.locationCount} location(s)? This cannot be undone.\n\nTip: export it first if you may want it back.`,
    );
    if (!ok) return;
    await this.run(async () => {
      await this.db.maps.deleteMap(m.id);
      this.toast.success(`Deleted "${m.name}".`);
      await this.load();
    });
  }

  protected async exportOne(m: MapSummary): Promise<void> {
    await this.run(async () => {
      downloadJson(`${safeFileName(m.name)}.json`, await this.db.maps.exportMaps([m.id]));
    });
  }

  protected async exportAll(): Promise<void> {
    await this.run(async () => {
      const file = await this.db.maps.exportMaps();
      downloadJson(`geoguess-maps-${new Date().toISOString().slice(0, 10)}.json`, file);
      this.toast.success(`Exported ${file.maps.length} map(s).`);
    });
  }

  protected async importFile(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    this.importErrors.set([]);
    await this.run(async () => {
      const result = parseImport(await file.text());
      if (!result.ok) {
        this.importErrors.set(result.errors);
        this.toast.error('Import failed. Nothing was changed.');
        return;
      }
      const created = await this.db.maps.importMaps(result.maps);
      this.toast.success(`Imported ${created.length} map(s) as new maps.`);
      await this.load();
    });
  }

  private async run(fn: () => Promise<void>): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      await fn();
    } catch (err) {
      this.toast.error(describeStorageError(err));
    } finally {
      this.busy.set(false);
    }
  }
}
