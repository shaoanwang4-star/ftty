-- 0002_firebase
-- 本地 users 行继续作为身份锚点（所有外键不变），Firebase uid 通过 firebase_uid 映射进来。
-- 旧的 pass_hash / pass_salt 保留，自建用户名密码登录仍可用；新登录走 Firebase。
ALTER TABLE users ADD COLUMN firebase_uid TEXT;
ALTER TABLE users ADD COLUMN email TEXT;
ALTER TABLE users ADD COLUMN display_name TEXT;
-- password | google | anonymous
ALTER TABLE users ADD COLUMN provider TEXT;

CREATE UNIQUE INDEX idx_users_firebase_uid ON users (firebase_uid) WHERE firebase_uid IS NOT NULL;
CREATE INDEX idx_users_email ON users (email) WHERE email IS NOT NULL;
