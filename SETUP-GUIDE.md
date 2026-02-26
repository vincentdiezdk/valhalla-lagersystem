# Valhalla Lagersystem – Supabase Opsætningsguide

## 1. Opret Supabase Projekt
1. Gå til [supabase.com](https://supabase.com) og opret en gratis konto
2. Klik "New Project" og vælg et navn (f.eks. "valhalla-lager")
3. Vælg et stærkt database-password og en region tæt på Danmark (eu-central-1)
4. Vent til projektet er oprettet (ca. 2 minutter)

## 2. Kør Database Setup
1. Gå til **SQL Editor** i dit Supabase dashboard
2. Klik "New Query"
3. Kopiér hele indholdet af `supabase-setup.sql` ind
4. Klik "Run"
5. Tjek at alle tabeller er oprettet under **Table Editor**

Scriptet opretter:
- 8 tabeller (profiles, categories, locations, items, item_categories, loans, reports, food_log)
- Row Level Security-politikker på alle tabeller
- Automatisk profil-oprettelse ved signup (trigger)
- Hjælpefunktioner til lageropgørelser (increment/decrement quantity)
- Storage bucket til billeder
- Seed-data (kategorier og lokationer)

## 3. Aktivér Email Auth
1. Gå til **Authentication → Providers**
2. Sørg for at "Email" provider er aktiveret
3. Under **Authentication → Settings**:
   - Slå "Enable email confirmations" **FRA** (for nem test)
   - Eller behold det **TIL** for produktion

## 4. Find dine API-nøgler
1. Gå til **Settings → API**
2. Kopiér **"Project URL"** (f.eks. `https://xxxxx.supabase.co`)
3. Kopiér **"anon public"** key (starter med `eyJ...`)

## 5. Konfigurér systemet

### Mulighed A: Via config-skærmen
1. Åbn `index.html` i en browser
2. Indtast Project URL og Anon Key
3. Klik "Forbind"

### Mulighed B: Hardcode i index.html
1. Åbn `index.html` i en teksteditor
2. Find linjen med `SUPABASE_CONFIG` (nær bunden)
3. Fjern kommentaren og indsæt dine nøgler:
```html
<script>window.SUPABASE_CONFIG = { url: 'https://xxxxx.supabase.co', anonKey: 'eyJ...' };</script>
```

## 6. Opret admin-bruger
1. Klik **"Opret konto"** på login-siden
2. Brug din email og et password (min. 6 tegn)
3. Gå til Supabase **Table Editor → profiles**
4. Find din bruger og ændr `role` fra `leader` til `admin`
5. Log ud og log ind igen — nu har du admin-rettigheder

## 7. Hosting
Du kan hoste filerne på enhver statisk hosting:
- **Netlify** (gratis)
- **Vercel** (gratis)
- **GitHub Pages** (gratis)
- Eller bare åbn `index.html` lokalt

Upload disse filer:
- `index.html`
- `style.css`
- `app.js`

(`supabase-setup.sql` og `SETUP-GUIDE.md` behøver ikke uploades — de er kun til opsætning.)

---

## Filstruktur

```
valhalla-lager/
├── index.html          ← Hovedside (inkluderer Supabase CDN)
├── style.css           ← Styling (uændret)
├── app.js              ← Applikationslogik (Supabase-version)
├── supabase-setup.sql  ← Database-setup (kør i SQL Editor)
├── SETUP-GUIDE.md      ← Denne guide
└── cgi-bin/api.py      ← Gammel backend (beholdt som reference)
```

## Forskelle fra den gamle version

| Emne | Før (CGI/SQLite) | Nu (Supabase) |
|------|-------------------|---------------|
| Backend | Python CGI + SQLite | Supabase (Postgres + Auth + Storage) |
| Login | Brugernavn/password | Email/password via Supabase Auth |
| Brugeroprettelse | Admin opretter brugere | Brugere opretter selv konto |
| Billeder | Base64 i lokal `assets/` mappe | Supabase Storage bucket |
| IDs | Integers (auto-increment) | UUIDs |
| Hosting | Kræver CGI-understøttet server | Enhver statisk hosting |

## Fejlfinding

**"Kunne ikke forbinde"** ved config-skærmen:
- Tjek at URL er korrekt (inkl. `https://`)
- Tjek at anon key er kopieret korrekt
- Tjek at SQL-setup er kørt succesfuldt

**Kan ikke oprette/ændre ting som admin:**
- Tjek at din `role` i profiles-tabellen er sat til `admin`
- Log ud og log ind igen efter rolleændring

**Billeder virker ikke:**
- Tjek at storage bucket `images` er oprettet (kør SQL-setup igen)
- Tjek at bucket er sat til "public"

**"Email not confirmed"** ved login:
- Gå til Supabase Authentication → Settings og slå email-bekræftelse fra
- Eller bekræft emailen via linket i den tilsendte mail