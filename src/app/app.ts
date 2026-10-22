import { ChangeDetectionStrategy, Component, OnInit, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter, map } from 'rxjs';
import { UsageService } from './services/usage.service';
import { ToastService } from './services/toast.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app.html',
})
export class App implements OnInit {
  private readonly router = inject(Router);
  protected readonly usage = inject(UsageService);
  protected readonly toast = inject(ToastService);

  protected readonly inGame = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map((e) => e.urlAfterRedirects.startsWith('/game')),
    ),
    { initialValue: false },
  );

  protected focusMain(): void {
    document.getElementById('main')?.focus();
  }

  ngOnInit(): void {
    void this.usage.refresh();
    if (navigator.storage?.persist) {
      // Ask the browser not to evict maps and usage records under storage pressure.
      void navigator.storage.persist().catch(() => undefined);
    }
  }
}
