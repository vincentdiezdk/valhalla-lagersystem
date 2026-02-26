-- ═══════════════════════════════════════════════════════════════════════
-- Valhalla Gruppe – Lagersystem: Supabase Database Setup
-- Kør dette i Supabase SQL Editor for at oprette alle tabeller, 
-- politikker, funktioner og seed-data.
-- ═══════════════════════════════════════════════════════════════════════

-- ─── TABLES ────────────────────────────────────────────────────────────

-- Profiles (linked to Supabase Auth users)
CREATE TABLE IF NOT EXISTS profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username text UNIQUE,
  display_name text NOT NULL,
  role text NOT NULL DEFAULT 'leader',
  created_at timestamptz DEFAULT now()
);

-- Categories
CREATE TABLE IF NOT EXISTS categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text DEFAULT '',
  responsible_person text DEFAULT '',
  icon text DEFAULT 'folder',
  created_at timestamptz DEFAULT now()
);

-- Locations
CREATE TABLE IF NOT EXISTS locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_name text NOT NULL,
  shelf_name text DEFAULT '',
  description text DEFAULT '',
  created_at timestamptz DEFAULT now()
);

-- Items
CREATE TABLE IF NOT EXISTS items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text DEFAULT '',
  type text NOT NULL DEFAULT 'equipment',
  image_url text DEFAULT '',
  barcode text DEFAULT '',
  quantity int DEFAULT 1,
  min_quantity int DEFAULT 0,
  location_id uuid REFERENCES locations(id),
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Item ↔ Category junction
CREATE TABLE IF NOT EXISTS item_categories (
  item_id uuid REFERENCES items(id) ON DELETE CASCADE,
  category_id uuid REFERENCES categories(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, category_id)
);

-- Loans
CREATE TABLE IF NOT EXISTS loans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid REFERENCES items(id),
  user_id uuid REFERENCES auth.users(id),
  -- Additional FK to profiles for PostgREST joins
  CONSTRAINT loans_user_id_fkey_profiles FOREIGN KEY (user_id) REFERENCES profiles(id),
  quantity int DEFAULT 1,
  purpose text DEFAULT 'private',
  trip_name text DEFAULT '',
  loan_date timestamptz DEFAULT now(),
  expected_return text,
  actual_return text,
  status text DEFAULT 'active'
);

-- Reports
CREATE TABLE IF NOT EXISTS reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid REFERENCES items(id),
  user_id uuid REFERENCES auth.users(id),
  -- Additional FK to profiles for PostgREST joins
  CONSTRAINT reports_user_id_fkey_profiles FOREIGN KEY (user_id) REFERENCES profiles(id),
  type text NOT NULL DEFAULT 'missing',
  description text DEFAULT '',
  image_url text DEFAULT '',
  status text DEFAULT 'open',
  admin_response text DEFAULT '',
  created_at timestamptz DEFAULT now(),
  resolved_at timestamptz
);

-- Food Log
CREATE TABLE IF NOT EXISTS food_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid REFERENCES items(id),
  user_id uuid REFERENCES auth.users(id),
  -- Additional FK to profiles for PostgREST joins
  CONSTRAINT food_log_user_id_fkey_profiles FOREIGN KEY (user_id) REFERENCES profiles(id),
  action text NOT NULL DEFAULT 'added',
  quantity int DEFAULT 1,
  scanned_barcode text DEFAULT '',
  created_at timestamptz DEFAULT now()
);


-- ─── HELPER FUNCTION: is_admin() ───────────────────────────────────────

CREATE OR REPLACE FUNCTION is_admin()
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'
  );
$$ LANGUAGE sql SECURITY DEFINER;


-- ─── AUTO-CREATE PROFILE ON SIGNUP ─────────────────────────────────────

CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO profiles (id, username, display_name, role)
  VALUES (
    NEW.id,
    NEW.email,
    split_part(NEW.email, '@', 1),
    'leader'
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Drop trigger if it already exists, then create
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();


-- ─── RPC FUNCTIONS FOR QUANTITY UPDATES ────────────────────────────────

CREATE OR REPLACE FUNCTION increment_item_quantity(p_item_id uuid, p_amount int)
RETURNS void AS $$
BEGIN
  UPDATE items SET quantity = quantity + p_amount, updated_at = now() WHERE id = p_item_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION decrement_item_quantity(p_item_id uuid, p_amount int)
RETURNS void AS $$
BEGIN
  UPDATE items SET quantity = GREATEST(0, quantity - p_amount), updated_at = now() WHERE id = p_item_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION set_item_quantity_zero(p_item_id uuid)
RETURNS void AS $$
BEGIN
  UPDATE items SET quantity = 0, updated_at = now() WHERE id = p_item_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- ─── ROW LEVEL SECURITY ────────────────────────────────────────────────

-- Enable RLS on all tables
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE items ENABLE ROW LEVEL SECURITY;
ALTER TABLE item_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE loans ENABLE ROW LEVEL SECURITY;
ALTER TABLE reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE food_log ENABLE ROW LEVEL SECURITY;

-- ── PROFILES ──
CREATE POLICY "profiles_select" ON profiles
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "profiles_insert" ON profiles
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = id);

CREATE POLICY "profiles_update" ON profiles
  FOR UPDATE TO authenticated USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

-- ── CATEGORIES ──
CREATE POLICY "categories_select" ON categories
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "categories_insert" ON categories
  FOR INSERT TO authenticated WITH CHECK (is_admin());

CREATE POLICY "categories_update" ON categories
  FOR UPDATE TO authenticated USING (is_admin()) WITH CHECK (is_admin());

CREATE POLICY "categories_delete" ON categories
  FOR DELETE TO authenticated USING (is_admin());

-- ── LOCATIONS ──
CREATE POLICY "locations_select" ON locations
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "locations_insert" ON locations
  FOR INSERT TO authenticated WITH CHECK (is_admin());

CREATE POLICY "locations_update" ON locations
  FOR UPDATE TO authenticated USING (is_admin()) WITH CHECK (is_admin());

CREATE POLICY "locations_delete" ON locations
  FOR DELETE TO authenticated USING (is_admin());

-- ── ITEMS ──
CREATE POLICY "items_select" ON items
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "items_insert" ON items
  FOR INSERT TO authenticated WITH CHECK (is_admin());

CREATE POLICY "items_update" ON items
  FOR UPDATE TO authenticated USING (is_admin()) WITH CHECK (is_admin());

CREATE POLICY "items_delete" ON items
  FOR DELETE TO authenticated USING (is_admin());

-- ── ITEM_CATEGORIES ──
CREATE POLICY "item_categories_select" ON item_categories
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "item_categories_insert" ON item_categories
  FOR INSERT TO authenticated WITH CHECK (is_admin());

CREATE POLICY "item_categories_delete" ON item_categories
  FOR DELETE TO authenticated USING (is_admin());

-- ── LOANS ──
CREATE POLICY "loans_select" ON loans
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "loans_insert" ON loans
  FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "loans_update" ON loans
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

-- ── REPORTS ──
CREATE POLICY "reports_select" ON reports
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "reports_insert" ON reports
  FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "reports_update" ON reports
  FOR UPDATE TO authenticated USING (is_admin()) WITH CHECK (is_admin());

-- ── FOOD_LOG ──
CREATE POLICY "food_log_select" ON food_log
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "food_log_insert" ON food_log
  FOR INSERT TO authenticated WITH CHECK (true);


-- ─── STORAGE BUCKET ───────────────────────────────────────────────────

INSERT INTO storage.buckets (id, name, public)
VALUES ('images', 'images', true)
ON CONFLICT (id) DO NOTHING;

-- Storage policies: authenticated users can upload
CREATE POLICY "images_upload" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'images');

-- Storage policies: anyone can read (public bucket)
CREATE POLICY "images_public_read" ON storage.objects
  FOR SELECT TO public
  USING (bucket_id = 'images');

-- Storage policies: authenticated users can update their own uploads
CREATE POLICY "images_update" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'images');

-- Storage policies: authenticated users can delete
CREATE POLICY "images_delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'images');


-- ─── SEED DATA ─────────────────────────────────────────────────────────

INSERT INTO categories (name, description, responsible_person, icon) VALUES
  ('Telte', 'Alt teltudstyr', '', 'tent'),
  ('Sankt Hans', 'Udstyr til Sankt Hans fejring', '', 'flame'),
  ('Bålmad', 'Udstyr og ingredienser til bålmad', '', 'cooking-pot'),
  ('Trangia', 'Trangia-komfurer og tilbehør', '', 'flame'),
  ('Kløvning', 'Udstyr til brændekløvning', '', 'axe'),
  ('Værksted', 'Værktøj og materialer', '', 'wrench'),
  ('Leg', 'Spil og legeudstyr', '', 'gamepad-2');

INSERT INTO locations (room_name, shelf_name, description) VALUES
  ('Materiale-rum', 'Hylde 1', 'Første hylde i materiale-rummet'),
  ('Materiale-rum', 'Hylde 2', 'Anden hylde i materiale-rummet'),
  ('Køkken', 'Skab 1', 'Første skab i køkkenet'),
  ('Køkken', 'Skab 2', 'Andet skab i køkkenet'),
  ('Loftet', '', 'Opbevaring på loftet');


-- ═══════════════════════════════════════════════════════════════════════
-- DONE! Tjek Table Editor for at bekræfte at alle tabeller er oprettet.
-- ═══════════════════════════════════════════════════════════════════════