## 0.2.0 (2026-10-12)

### 🚀 Features

- **analytics:** szkielet paczki garmin-mcp-analytics (E6-1) ([d0e308d](https://github.com/endurancetools/garmin-mcp/commit/d0e308d))
- **analytics:** progi z historią i grupa sportu (E6-4) ([6ba6496](https://github.com/endurancetools/garmin-mcp/commit/6ba6496))
- **analytics:** metryki sesji, obciążenie, intensywność i efektywność (E6-5) ([8363ceb](https://github.com/endurancetools/garmin-mcp/commit/8363ceb))
- **analytics:** gotowość dnia GO/MODIFY/REST (E6-6) ([9de07fd](https://github.com/endurancetools/garmin-mcp/commit/9de07fd))
- **analytics:** AnalyticsService i outputSchema narzędzi (E6-7) ([20d8c21](https://github.com/endurancetools/garmin-mcp/commit/20d8c21))
- **analytics:** by_sport i hrmax w get_thresholds (E6-8b) ([ec3ce85](https://github.com/endurancetools/garmin-mcp/commit/ec3ce85))
- **analytics:** thresholds_used w get_load w kształcie by_sport (E6-8bb) ([c1268c0](https://github.com/endurancetools/garmin-mcp/commit/c1268c0))
- **analytics:** profil Garmina dociągany przy odczytach analityki (E6-8bc) ([a25979f](https://github.com/endurancetools/garmin-mcp/commit/a25979f))
- **analytics:** rozgrzewka modelu formy w gotowości i flagach (E6-14) ([ea57872](https://github.com/endurancetools/garmin-mcp/commit/ea57872))
- **analytics:** fallback LTHR z HRmax profilu i LT1 per sport (E6-15) ([138b03e](https://github.com/endurancetools/garmin-mcp/commit/138b03e))
- **analytics:** strefy Garmina na 3 strefy Seilera po granicach z profilu (E6-16) ([67f3ff0](https://github.com/endurancetools/garmin-mcp/commit/67f3ff0))
- **analytics:** week_jump na kroczących 7 dniach (E6-17) ([e2e4b4d](https://github.com/endurancetools/garmin-mcp/commit/e2e4b4d))
- **analytics:** filtr tlenowy EF na LT1 (E6-18) ([ba595cc](https://github.com/endurancetools/garmin-mcp/commit/ba595cc))
- **analytics:** hierarchia źródeł obciążenia moc -> tempo -> tętno (E6-19) ([03a5245](https://github.com/endurancetools/garmin-mcp/commit/03a5245))
- **analytics:** sRPE jako ostatnie źródło obciążenia (E6-20) ([8aa1697](https://github.com/endurancetools/garmin-mcp/commit/8aa1697))
- **analytics:** rozkład intensywności dla narciarstwa biegowego i wioślarstwa (E6-21) ([d6d0c4a](https://github.com/endurancetools/garmin-mcp/commit/d6d0c4a))
- **analytics:** polskie etykiety CSV dla narciarstwa biegowego i wioślarstwa (E6-21a) ([bad5501](https://github.com/endurancetools/garmin-mcp/commit/bad5501))
- **analytics:** rakiety śnieżne snow_shoe_ws w grupie nordic (E6-21b) ([0fe2e50](https://github.com/endurancetools/garmin-mcp/commit/0fe2e50))
- **analytics:** nota o rozjeździe własnego obciążenia i loadu Garmina (E6-24) ([75de47b](https://github.com/endurancetools/garmin-mcp/commit/75de47b))
- **analytics:** hrTSS z czasu w strefach tętna (E6-25) ([36e9c6c](https://github.com/endurancetools/garmin-mcp/commit/36e9c6c))
- **analytics:** sTSS dla pływania z CSS (E6-26) ([4be94ab](https://github.com/endurancetools/garmin-mcp/commit/4be94ab))
- **analytics:** forma per sport obok łącznej w get_load (E6-27) ([841ff1a](https://github.com/endurancetools/garmin-mcp/commit/841ff1a))
- **analytics:** Training Readiness Garmina jako sygnał info w get_readiness (E6-28) ([fc61d8d](https://github.com/endurancetools/garmin-mcp/commit/fc61d8d))
- **analytics:** sygnał HRV bez statusu Garmina w get_readiness (E6-29) ([2fa1e2a](https://github.com/endurancetools/garmin-mcp/commit/2fa1e2a))
- **analytics:** strefy tętna i mocy z profilu w get_thresholds (E6-37) ([a7358bd](https://github.com/endurancetools/garmin-mcp/commit/a7358bd))
- **cli:** komendy load, readiness, thresholds i import-activities (E6-9) ([040e9ec](https://github.com/endurancetools/garmin-mcp/commit/040e9ec))
- **cli:** garmin load --by-sport z formą per sport (E6-27b) ([8d058d9](https://github.com/endurancetools/garmin-mcp/commit/8d058d9))
- **domain:** publiczne pokrycie danych w GarminService (E6-2) ([c92c7da](https://github.com/endurancetools/garmin-mcp/commit/c92c7da))
- **domain:** CTL/ATL/TSB z loadu Garmina pod jedną nazwą garmin_load_model (E6-36) ([49c7b93](https://github.com/endurancetools/garmin-mcp/commit/49c7b93))
- **mcp-server:** narzędzia get_load, get_readiness, get_thresholds i set_threshold (E6-8) ([c68e9c4](https://github.com/endurancetools/garmin-mcp/commit/c68e9c4))
- **mcp-server:** preview_workout scalone w create_workout z dry_run (E6-39) ([f15e53d](https://github.com/endurancetools/garmin-mcp/commit/f15e53d))
- **store:** migracja 6 z tabelami analityki thresholds i imported_activities (E6-3) ([c7f2b11](https://github.com/endurancetools/garmin-mcp/commit/c7f2b11))

### 🩹 Fixes

- **mcp-server:** strefy Z1/Z2/Z3 względem LT1 kierują do get_load (E6-39b) ([47cc375](https://github.com/endurancetools/garmin-mcp/commit/47cc375))
- **repo:** wersja serwera i CLI czytana z package.json (R-2a) ([2571641](https://github.com/endurancetools/garmin-mcp/commit/2571641))

### ❤️ Thank You

- Marcin Milewicz

## 0.1.1 (2026-10-12)

### 🩹 Fixes

- **config:** test expandPath niezależny od platformy, pełny check przy wydaniu (E0-6) ([8d0a983](https://github.com/endurancetools/garmin-mcp/commit/8d0a983))
- **repo:** better-sqlite3 z gotowych binarek zamiast node-gyp (E0-6) ([0c24a86](https://github.com/endurancetools/garmin-mcp/commit/0c24a86))
- **repo:** testy serwera i doctor na Windows (E0-6) ([8ada121](https://github.com/endurancetools/garmin-mcp/commit/8ada121))

### ❤️ Thank You

- Marcin Milewicz