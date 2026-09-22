-- The first Solana payment was stored with its payer lowercased, before addresses were kept as they are.
UPDATE settlements SET payer = '3az6SBs6ivAan7Vz4UkPZEEwVRe413t8EHiYM2bQCiU1', pay_to = '26SsHut3dRbK9cWUJcrMfkKn3TKXSFMw61zyqm6tgWjK' WHERE rail = 'solana' AND lower(payer) = '3az6sbs6ivaan7vz4ukpzeewvre413t8ehiym2bqciu1';
SELECT payer, pay_to FROM settlements WHERE rail = 'solana';
