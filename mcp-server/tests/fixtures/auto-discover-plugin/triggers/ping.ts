// trivial trigger script — content irrelevant for the loader test
process.stdout.write(JSON.stringify({ callback: { trigger_event_name: 'TriggerFired', trigger_id: 'auto-test.ping' } }));
process.exit(0);
