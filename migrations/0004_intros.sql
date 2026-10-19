-- Who Plates has already introduced itself to, so the welcome DM is sent once.
CREATE TABLE user_intros (
  user_id   TEXT PRIMARY KEY,
  intro_at  INTEGER NOT NULL
);
