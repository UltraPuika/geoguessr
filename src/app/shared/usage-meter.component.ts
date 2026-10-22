import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { UsageService } from '../services/usage.service';
import { formatDate } from './util';

@Component({
  selector: 'app-usage-meter',
  imports: [DecimalPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (status(); as s) {
      <div class="usage-meter" [class.compact]="compact()">
        @if (s.state !== 'ok') {
          <p class="alert alert-error" role="alert">
            <strong>Street View is blocked.</strong> {{ s.message }}
            @if (!compact()) {
              See Settings to resolve this.
            }
          </p>
        } @else {
          <div class="usage-row">
            <span>
              <strong>{{ s.counted | number }}</strong> / {{ s.limit | number }} Street View loads this month
            </span>
            <span class="muted">{{ s.remaining | number }} left · {{ s.percent | number: '1.0-1' }}%</span>
          </div>
          <div
            class="bar"
            role="progressbar"
            [attr.aria-valuenow]="s.counted"
            aria-valuemin="0"
            [attr.aria-valuemax]="s.limit"
            aria-label="Monthly Street View usage"
          >
            <div class="bar-fill" [class]="'level-' + s.warningLevel" [style.width.%]="s.percent"></div>
          </div>
          @if (s.warningLevel === 100) {
            <p class="alert alert-error" role="alert">
              Monthly limit reached. New Street View viewers are blocked until {{ resetText() }}. Maps, history
              and settings remain available.
            </p>
          } @else if (s.warningLevel >= 80) {
            <p class="alert alert-warn">{{ s.warningLevel }}% of this month's Street View allowance used.</p>
          }
          @if (!compact()) {
            <p class="muted small">Counter resets {{ resetText() }} (start of the month in US Pacific time).</p>
          }
        }
      </div>
    } @else {
      <p class="muted">Checking Street View usage…</p>
    }
  `,
})
export class UsageMeterComponent {
  private readonly usage = inject(UsageService);
  readonly compact = input(false);
  readonly status = this.usage.status;
  readonly resetText = computed(() => {
    const s = this.status();
    return s ? formatDate(s.nextReset) : '';
  });
}
