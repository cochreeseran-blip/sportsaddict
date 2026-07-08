-- MLB Stats API returned venue names that differ from the base names seeded
-- in 001_init.sql, presumably due to sponsorship naming as of the 2026
-- season (observed live via Railway deploy logs). Same physical parks, same
-- coordinates/orientation as their base entries.
INSERT INTO park_orientations (venue, latitude, longitude, out_bearing_degrees) VALUES
  ('Tropicana Field', 27.7683, -82.6534, 45),
  ('UNIQLO Field at Dodger Stadium', 34.0739, -118.2400, 20)
ON CONFLICT (venue) DO NOTHING;
