-- Store the customer name sent by Lynk.id alongside the license email.
ALTER TABLE licenses ADD COLUMN name TEXT;
