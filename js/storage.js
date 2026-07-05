window.Hyumu = window.Hyumu || {};

Hyumu.Storage = (function () {
  let db = null;

  function getDb() {
    if (!db) {
      const app = firebase.apps.length ? firebase.app() : firebase.initializeApp(window.HYUMU_FIREBASE_CONFIG);
      db = app.firestore();
    }
    return db;
  }

  function monthsCollection(store) {
    return getDb().collection('stores').doc(store).collection('months');
  }

  async function loadIndex(store) {
    const snap = await monthsCollection(store).get();
    const index = snap.docs.map((d) => ({ key: d.id, label: labelFromKey(d.id) }));
    index.sort((a, b) => a.key.localeCompare(b.key));
    return index;
  }

  function labelFromKey(key) {
    const [y, m] = key.split('-').map(Number);
    return `${y}년 ${m}월`;
  }

  async function loadMonth(store, year, month) {
    const key = Hyumu.Model.monthKey(year, month);
    const doc = await monthsCollection(store).doc(key).get();
    return doc.exists ? doc.data() : null;
  }

  async function saveMonth(store, doc) {
    const key = Hyumu.Model.monthKey(doc.month.year, doc.month.month);
    await monthsCollection(store).doc(key).set(doc);
  }

  async function deleteMonth(store, year, month) {
    const key = Hyumu.Model.monthKey(year, month);
    await monthsCollection(store).doc(key).delete();
  }

  async function loadOrCreateMonth(store, year, month) {
    let doc = await loadMonth(store, year, month);
    if (!doc) {
      doc = Hyumu.Model.createMonthDoc(year, month);
      const carried = await copyEmployeesFromLatest(store, year, month);
      if (carried.length > 0) {
        doc.employees = carried;
        doc.meta.nextEmployeeId = carried.length + 1;
      }
      await saveMonth(store, doc);
    }
    return doc;
  }

  async function copyEmployeesFromLatest(store, year, month) {
    const key = Hyumu.Model.monthKey(year, month);
    const index = await loadIndex(store);
    const candidates = index
      .filter((e) => e.key < key)
      .sort((a, b) => b.key.localeCompare(a.key));
    if (candidates.length === 0) return [];
    const [y, m] = candidates[0].key.split('-').map(Number);
    const prev = await loadMonth(store, y, m);
    if (!prev) return [];
    return prev.employees.map((e) => ({
      id: e.id,
      name: e.name,
      recurringOff: [...e.recurringOff],
      specificOff: [],
      specificOffTypes: {},
      shiftPreference: e.shiftPreference || 'ANY',
      edgeShiftPreference: !!e.edgeShiftPreference,
      corner: e.corner || '',
      corners: Hyumu.Model.employeeCorners(e)
    }));
  }

  function subscribeMonth(store, year, month, onChange) {
    const key = Hyumu.Model.monthKey(year, month);
    return monthsCollection(store)
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
