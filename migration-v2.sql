-- ═══════════════════════════════════════════════════════════════════════
-- Valhalla Lagersystem – Migration V2: Nye features
-- Kør dette i Supabase SQL Editor
-- ═══════════════════════════════════════════════════════════════════════

-- ─── 1. NYE KOLONNER PÅ EKSISTERENDE TABELLER ──────────────────────

-- Udløbsdato på items (for madvarer)
ALTER TABLE items ADD COLUMN IF NOT EXISTS expiry_date date;

-- Ansvarlig bruger per kategori (reference til profiles)
ALTER TABLE categories ADD COLUMN IF NOT EXISTS responsible_user_id uuid REFERENCES profiles(id);

-- ─── 2. ITEM SETS / KITS (Sæt-system) ──────────────────────────────

CREATE TABLE IF NOT EXISTS item_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text DEFAULT '',
  image_url text DEFAULT '',
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz DEFAULT now()
);

-- Junction: hvilke genstande indgår i et sæt (med antal)
CREATE TABLE IF NOT EXISTS set_items (
  set_id uuid REFERENCES item_sets(id) ON DELETE CASCADE,
  item_id uuid REFERENCES items(id) ON DELETE CASCADE,
  quantity int DEFAULT 1,
  PRIMARY KEY (set_id, item_id)
);

-- ─── 3. EKSTRA BILLEDER PER GENSTAND ─────────────────────────────

CREATE TABLE IF NOT EXISTS item_images (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid REFERENCES items(id) ON DELETE CASCADE,
  image_url text NOT NULL,
  caption text DEFAULT '',
  sort_order int DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

-- ─── 4. AKTIVITETSLOG ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS activity_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id),
  CONSTRAINT activity_log_user_id_fkey_profiles FOREIGN KEY (user_id) REFERENCES profiles(id),
  action text NOT NULL,           -- 'loan_created', 'loan_returned', 'item_created', 'report_created', 'food_added', 'food_used', 'set_created', etc.
  entity_type text NOT NULL,      -- 'item', 'loan', 'report', 'food_log', 'set', 'trip'
  entity_id uuid,                 -- ID af den relevante genstand/udlån/rapport
  description text DEFAULT '',    -- Menneskelæsbar beskrivelse
  metadata jsonb DEFAULT '{}',    -- Extra data (item_name, quantity, etc.)
  created_at timestamptz DEFAULT now()
);

-- ─── 5. PAKKELISTER TIL TURE ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS trips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text DEFAULT '',
  start_date date,
  end_date date,
  status text DEFAULT 'planning',  -- 'planning', 'packing', 'active', 'completed'
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS trip_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid REFERENCES trips(id) ON DELETE CASCADE,
  item_id uuid REFERENCES items(id),
  set_id uuid REFERENCES item_sets(id),  -- Kan tilføje et helt sæt
  quantity_needed int DEFAULT 1,
  quantity_packed int DEFAULT 0,
  packed_by uuid REFERENCES auth.users(id),
  packed_at timestamptz,
  notes text DEFAULT '',
  CHECK (item_id IS NOT NULL OR set_id IS NOT NULL)  -- Enten item eller sæt
);

-- ─── 6. RLS POLICIES FOR NYE TABELLER ──────────────────────────────

ALTER TABLE item_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE set_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE item_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE trips ENABLE ROW LEVEL SECURITY;
ALTER TABLE trip_items ENABLE ROW LEVEL SECURITY;

-- Item Sets
CREATE POLICY "item_sets_select" ON item_sets FOR SELECT TO authenticated USING (true);
CREATE POLICY "item_sets_insert" ON item_sets FOR INSERT TO authenticated WITH CHECK (is_admin());
CREATE POLICY "item_sets_update" ON item_sets FOR UPDATE TO authenticated USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY "item_sets_delete" ON item_sets FOR DELETE TO authenticated USING (is_admin());

-- Set Items
CREATE POLICY "set_items_select" ON set_items FOR SELECT TO authenticated USING (true);
CREATE POLICY "set_items_insert" ON set_items FOR INSERT TO authenticated WITH CHECK (is_admin());
CREATE POLICY "set_items_delete" ON set_items FOR DELETE TO authenticated USING (is_admin());

-- Item Images
CREATE POLICY "item_images_select" ON item_images FOR SELECT TO authenticated USING (true);
CREATE POLICY "item_images_insert" ON item_images FOR INSERT TO authenticated WITH CHECK (is_admin());
CREATE POLICY "item_images_delete" ON item_images FOR DELETE TO authenticated USING (is_admin());

-- Activity Log
CREATE POLICY "activity_log_select" ON activity_log FOR SELECT TO authenticated USING (true);
CREATE POLICY "activity_log_insert" ON activity_log FOR INSERT TO authenticated WITH CHECK (true);

-- Trips
CREATE POLICY "trips_select" ON trips FOR SELECT TO authenticated USING (true);
CREATE POLICY "trips_insert" ON trips FOR INSERT TO authenticated WITH CHECK (is_admin());
CREATE POLICY "trips_update" ON trips FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "trips_delete" ON trips FOR DELETE TO authenticated USING (is_admin());

-- Trip Items
CREATE POLICY "trip_items_select" ON trip_items FOR SELECT TO authenticated USING (true);
CREATE POLICY "trip_items_insert" ON trip_items FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "trip_items_update" ON trip_items FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "trip_items_delete" ON trip_items FOR DELETE TO authenticated USING (is_admin());

-- ═══════════════════════════════════════════════════════════════════════
-- DONE! Tjek Table Editor for at bekræfte nye tabeller.
-- ═══════════════════════════════════════════════════════════════════════
