window.Hyumu = window.Hyumu || {};

Hyumu.App = (function () {
  const Model = Hyumu.Model;
  const Storage = Hyumu.Storage;
  const Scheduler = Hyumu.Scheduler;
  const Render = Hyumu.Render;

  let state = null;
  let doc = null;
  let unsubscribe = null;
  let authScreen = 'login';

  let headerEl, navEl, contentEl;

  async function init() {
    headerEl = document.getElementById('app-header');
    navEl = document.getElementById('app-nav');
    contentEl = document.getElementById('app-content');

    const session = Hyumu.Auth.getCurrentUser();
    if (!session) {
      headerEl.innerHTML = '';
      navEl.innerHTML = '';
      Render.renderLoginScreen(contentEl, authHandlers);
      return;
    }

    await enterApp(session.employeeId, session.store);
  }

  async function enterApp(employeeId, store) {
    const now = new Date();
    state = { year: now.getFullYear(), month: now.getMonth() + 1, screen: 'employees', employeeId, store };
    doc = await Storage.loadOrCreateMonth(store, state.year, state.month);

    subscribeCurrentMonth();
    renderAll();
  }

  const authHandlers = {
    onGotoSignup() {
      authScreen = 'signup';
      Render.renderSignupScreen(contentEl, authHandlers);
    },
    onGotoLogin() {
      authScreen = 'login';
      Render.renderLoginScreen(contentEl, authHandlers);
    },
    async onLogin(employeeId, password) {
      try {
        const session = await Hyumu.Auth.login(employeeId, password);
        await enterApp(session.employeeId, session.store);
      } catch (e) {
        Render.renderLoginScreen(contentEl, authHandlers, e.message);
      }
    },
    async onSignup(employeeId, password, phone, store) {
      try {
        const session = await Hyumu.Auth.signup(employeeId, password, phone, store);
        await enterApp(session.employeeId, session.store);
      } catch (e) {
        Render.renderSignupScreen(contentEl, authHandlers, e.message);
      }
    },
    onLogout() {
      Hyumu.Auth.logout();
      if (unsubscribe) unsubscribe();
      unsubscribe = null;
      doc = null;
      state = null;
      authScreen = 'login';
      Render.renderLoginScreen(contentEl, authHandlers);
      headerEl.innerHTML = '';
      navEl.innerHTML = '';
    }
  };

  function subscribeCurrentMonth() {
    if (unsubscribe) unsubscribe();
    unsubscribe = Storage.subscribeMonth(state.store, state.year, state.month, (remoteDoc) => {
      doc = remoteDoc;
      if (state.screen === 'calendar') {
        renderContent();
      }
    });
  }

  async function save() {
    await Storage.saveMonth(state.store, doc);
  }

  async function renderAll() {
    await Render.renderHeader(headerEl, state, headerHandlers);
    Render.renderNav(navEl, state, navHandlers);
    renderContent();
  }

  function renderContent() {
    if (state.screen === 'employees') {
      Render.renderEmployeeScreen(contentEl, doc, employeeHandlers);
    } else if (state.screen === 'rules') {
      Render.renderRulesScreen(contentEl, doc, rulesHandlers);
    } else {
      Render.renderCalendarScreen(contentEl, doc, calendarHandlers);
    }
  }

  const headerHandlers = {
    async onChangeMonth(delta) {
      let { year, month } = state;
      month += delta;
      if (month < 1) { month = 12; year -= 1; }
      if (month > 12) { month = 1; year += 1; }
      state.year = year;
      state.month = month;
      doc = await Storage.loadOrCreateMonth(state.store, year, month);
      subscribeCurrentMonth();
      renderAll();
    },
    async onJumpMonth(year, month) {
      state.year = year;
      state.month = month;
      doc = await Storage.loadOrCreateMonth(state.store, year, month);
      subscribeCurrentMonth();
      renderAll();
    },
    onLogout() {
      authHandlers.onLogout();
    }
  };

  const navHandlers = {
    onNavigate(screen) {
      state.screen = screen;
      Render.renderNav(navEl, state, navHandlers);
      renderContent();
    }
  };

  const employeeHandlers = {
    async onAddEmployee() {
      const id = `emp${doc.meta.nextEmployeeId++}`;
      doc.employees.push(Model.createEmployee(id, `직원${doc.employees.length + 1}`));
      await save();
      renderContent();
    },
    async onRemoveEmployee(id) {
      doc.employees = doc.employees.filter((e) => e.id !== id);
      delete doc.schedule[id];
      await save();
      renderContent();
    },
    async onRenameEmployee(id, name) {
      const emp = doc.employees.find((e) => e.id === id);
      if (emp) {
        emp.name = name;
        await save();
      }
    },
    async onToggleRecurring(id, weekday, checked) {
      const emp = doc.employees.find((e) => e.id === id);
      if (!emp) return;
      if (checked && !emp.recurringOff.includes(weekday)) {
        emp.recurringOff.push(weekday);
      } else if (!checked) {
        emp.recurringOff = emp.recurringOff.filter((wd) => wd !== weekday);
      }
      await save();
    },
    async onAddSpecificOff(id, date) {
      const emp = doc.employees.find((e) => e.id === id);
      if (!emp) return;
      if (!emp.specificOff.includes(date)) {
        emp.specificOff.push(date);
        emp.specificOff.sort();
      }
      await save();
      renderContent();
    },
    async onRemoveSpecificOff(id, date) {
      const emp = doc.employees.find((e) => e.id === id);
      if (!emp) return;
      emp.specificOff = emp.specificOff.filter((d) => d !== date);
      await save();
      renderContent();
    },
    async onUpdateShiftPreference(id, value) {
      const emp = doc.employees.find((e) => e.id === id);
      if (!emp) return;
      emp.shiftPreference = value;
      await save();
    },
    async onUpdateCorners(id, corners) {
      const emp = doc.employees.find((e) => e.id === id);
      if (!emp) return;
      emp.corners = corners;
      emp.corner = corners[0] || '';
      await save();
    }
  };

  const rulesHandlers = {
    async onUpdateRule(key, value) {
      doc.rules[key] = value;
      await save();
      renderContent();
    },
    async onUpdateWeekdayOverride(weekday, value) {
      if (value === null) {
        delete doc.rules.minStaffByWeekday[weekday];
      } else {
        doc.rules.minStaffByWeekday[weekday] = value;
      }
      await save();
    },
    async onUpdateCornerShiftMinStaff(corner, shift, value) {
      if (!doc.rules.minStaffByCorner) doc.rules.minStaffByCorner = {};
      const entry = doc.rules.minStaffByCorner[corner] || {};
      if (value === null) {
        delete entry[shift];
      } else {
        entry[shift] = value;
      }
      if (Object.keys(entry).length === 0) {
        delete doc.rules.minStaffByCorner[corner];
      } else {
        doc.rules.minStaffByCorner[corner] = entry;
      }
      await save();
    },
    async onUpdateDateLabel(date, label) {
      if (!doc.rules.dateLabels) doc.rules.dateLabels = {};
      if (label === null) {
        delete doc.rules.dateLabels[date];
      } else {
        doc.rules.dateLabels[date] = label;
      }
      await save();
      renderContent();
    },
    async onUpdateDateOverride(date, value) {
      if (value === null) {
        delete doc.rules.minStaffByDate[date];
      } else {
        doc.rules.minStaffByDate[date] = value;
      }
      await save();
      renderContent();
    },
    async onGenerate() {
      Scheduler.generateSchedule(doc);
      await save();
      state.screen = 'calendar';
      Render.renderNav(navEl, state, navHandlers);
      renderContent();
    }
  };

  const calendarHandlers = {
    async onToggleCell(empId, date, currentStatus, currentShift) {
      let next;
      if (currentStatus === 'OFF') {
        next = { status: 'WORK', shift: 'MORNING' };
      } else if (currentShift === 'MORNING') {
        next = { status: 'WORK', shift: 'AFTERNOON' };
      } else {
        next = { status: 'OFF', shift: null };
      }
      if (!doc.schedule[empId]) doc.schedule[empId] = {};
      doc.schedule[empId][date] = { status: next.status, source: 'MANUAL', shift: next.shift };
      await save();
      renderContent();
    },
    async onRegenerate() {
      Scheduler.generateSchedule(doc);
      await save();
      renderContent();
    },
    async onResetManual() {
      for (const empId of Object.keys(doc.schedule)) {
        const empSchedule = doc.schedule[empId];
        for (const date of Object.keys(empSchedule)) {
          if (empSchedule[date].source === 'MANUAL') {
            delete empSchedule[date];
          }
        }
      }
      Scheduler.generateSchedule(doc);
      await save();
      renderContent();
    }
  };

  return { init };
})();

document.addEventListener('DOMContentLoaded', Hyumu.App.init);
