INSERT INTO permissions (key, description)
VALUES ('document.search', 'Search authorized documents and OCR text')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role, permission)
SELECT r.role, 'document.search'
FROM (VALUES ('ADMIN'),('FINANCE'),('EXECUTIVE'),('EVENT_HEAD'),('MEMBER'),('AUDITOR')) AS r(role)
ON CONFLICT DO NOTHING;
