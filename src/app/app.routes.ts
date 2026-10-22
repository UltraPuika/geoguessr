import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', loadComponent: () => import('./features/home/home.component').then((m) => m.HomeComponent), title: 'Maps' },
  {
    path: 'maps/:id',
    loadComponent: () => import('./features/editor/map-editor.component').then((m) => m.MapEditorComponent),
    title: 'Edit map',
  },
  {
    path: 'play/:mapId',
    loadComponent: () => import('./features/setup/game-setup.component').then((m) => m.GameSetupComponent),
    title: 'New game',
  },
  { path: 'game', loadComponent: () => import('./features/game/game.component').then((m) => m.GameComponent), title: 'Playing' },
  {
    path: 'results/:id',
    loadComponent: () => import('./features/results/results.component').then((m) => m.ResultsComponent),
    title: 'Results',
  },
  {
    path: 'history',
    loadComponent: () => import('./features/history/history.component').then((m) => m.HistoryComponent),
    title: 'History',
  },
  {
    path: 'settings',
    loadComponent: () => import('./features/settings/settings.component').then((m) => m.SettingsComponent),
    title: 'Settings & usage',
  },
  { path: '**', redirectTo: '' },
];
