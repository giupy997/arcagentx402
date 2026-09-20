-- The five direct settlements made before the settlements table existed, taken from the
-- facilitator's own log (journalctl -u cra-agent-facilitator). Safe to run twice.
INSERT INTO settlements (at, rail, network, outcome, payer, pay_to, amount_usdc6, tx) VALUES
 ('2026-09-20T14:01:24.994Z','direct','eip155:5042','settled','0xe5a67b7ddf06a6e63a8e0423195aa3b76002cf2b','0x33b37c6d7a98b58da3ccb3f36a4b578053d0ea74',500,'0x903a75fb579f4f6eb6b7ffb90ff3f7de405f117e9aed78d1f21c23a0f1fa0250'),
 ('2026-09-20T14:09:50.293Z','direct','eip155:5042','settled','0xe5a67b7ddf06a6e63a8e0423195aa3b76002cf2b','0x33b37c6d7a98b58da3ccb3f36a4b578053d0ea74',3000,'0xd2d076fa5eda1a070e4a1ed2b7976ad85ba6a9f1f4fe4bfe79e12b34f83282ba'),
 ('2026-09-20T14:34:28.166Z','direct','eip155:5042','settled','0xc086ec0e6db3f6ef3efa486d138942cf5cf2ac8f','0x33b37c6d7a98b58da3ccb3f36a4b578053d0ea74',3000,'0xb88d69d4fcb2e0688031d1ae0d2bdb91a7bb8e1441acd0dce5684e0ba244033a'),
 ('2026-09-20T14:38:52.345Z','direct','eip155:5042','settled','0xc086ec0e6db3f6ef3efa486d138942cf5cf2ac8f','0x33b37c6d7a98b58da3ccb3f36a4b578053d0ea74',3000,'0xa95ad4b09a598573e25e656316ee1d06996a02ebcfea3cc0fdfe571a7d3122ed'),
 ('2026-09-20T14:40:48.399Z','direct','eip155:5042','settled','0xc086ec0e6db3f6ef3efa486d138942cf5cf2ac8f','0x33b37c6d7a98b58da3ccb3f36a4b578053d0ea74',3000,'0x8823d42dd89a6b795dfd5c8cf78c2d3f50b625af78a07b947815e4bd233cbcf8')
ON CONFLICT DO NOTHING;
SELECT count(*) AS settlements FROM settlements;
