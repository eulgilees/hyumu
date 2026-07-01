window.Hyumu = window.Hyumu || {};

Hyumu.Storage = (function () {
  let db = null;

  function getDb() {
    if (!db) {
      const app = firebase.initializeApp(window.HYUMU_FIREBASE_CONFIG);
      db = app.firestore();
    }
    return db;
  }

  async function loadIndex() {
    const snap = await getDb().collection('months').get();
    const index = snap.docs.map((d) => ({ key: d.id, label: labelFromKey(d.id) }));
    index.sort((a, b) => a.key.localeCompare(b.key));
    return index;
  }

  function labelFromKey(key) {
    const [y, m] = key.split('-').map(Number);
    return `${y}년 ${m}월`;
  }

  async function loadMonth(year, month) {
    const key = Hyumu.Model.monthKey(year, month);
    const doc = await getDb().collection('months').doc(key).get();
    return doc.exists ? doc.data() : null;
  }

  async function saveMonth(doc) {
    const key = Hyumu.Model.monthKey(doc.month.year, doc.month.month);
    await getDb().collection('months').doc(key).set(doc);
  }

  async function deleteMonth(year, month) {
    const key = Hyumu.Model.monthKey(year, month);
    await getDb().collection('months').doc(key).delete();
  }

  async function loadOrCreateMonth(year, month) {
    let doc = await loadMonth(year, month);
    if (!doc) {
      doc = Hyumu.Model.createMonthDoc(year, month);
      const carried = await copyEmployeesFromLatest(year, month);
      if (carried.length > 0) {
        doc.employees = carried;
        doc.meta.nextEmployeeId = carried.length + 1;
      }
      await saveMonth(doc);
    }
    return doc;
  }

  async function copyEmployeesFromLatest(year, month) {
    const key = Hyumu.Model.monthKey(year, month);
    const index = await loadIndex();
    const candidates = index
      .filter((e) => e.key < key)
      .sort((a, b) => b.key.localeCompare(a.key));
    if (candidates.length === 0) return [];
    const [y, m] = candidates[0].key.split('-').map(Number);
    const prev = await loadMonth(y, m);
    if (!prev) return [];
    return prev.employees.map((e) => ({
      id: e.id,
      name: e.name,
      recurringOff: [...e.recurringOff],
      specificOff: [],
      shiftPreference: e.shiftPreference || 'ANY'
    }));
  }

  function subscribeMonth(year, month, onChange) {
    const key = Hyumu.Model.monthKey(year, month);
    return getDb()
      .collection('months')
      .doc(key)
      .onSnapshot((snap) => {
        if (snap.exists) onChange(snap.data());
      });
  }

  return {
    loadIndex,
    loadMonth,
    saveMonth,
    deleteMonth,
    loadOrCreateMonth,
    copyEmployeesFromLatest,
    subscribeMonth
  };
})();
