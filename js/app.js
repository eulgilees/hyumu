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
    state = { year: now.getFullYear(), month: now.getMonth() + 1, screen: 'employees', employeeId, store, calendarView: 'adjusted' };
    doc = await Storage.loadOrCreateMonth(store, state.year, state.month);

    subscribeCurrentMonth();
    renderAll();
  }

  // 전달 마지막 며칠의 실제 근무 기록을 이어받아야 이번 달 1일부터 다들 동시에 상한에 닿는
  // 문제가 안 생긴다(사장님 지시: "전달 휴무를 고려해서 월초 휴무까지 짜야하는데") — 없으면
  // (매장 첫 달 등) undefined로 넘어가고 스케줄러가 0부터 시작하는 기존 동작으로 처리한다.
  async function loadPreviousMonthDoc() {
    let { year, month } = doc.month;
    month -= 1;
    if (month < 1) { month = 12; year -= 1; }
    return await Storage.loadMonth(state.store, year, month);
  }

  const FULL_OFF_TYPES = ['PERSONAL', 'ANNUAL', 'CHEDAN', 'RECOGNIZED'];

  // 달력에서 고른 한 달치 선택({날짜: 선택값})을 실제로 그 날짜가 속한 달 문서(targetDoc)에
  // 반영한다. 반차(HALF_MORNING/HALF_AFTERNOON)는 오전/오후 중 절반만 쉬는 것이므로 하루
  // 전체를 잠그는 specificOff가 아니라, 일하는 나머지 반쪽 근무를 확정하는 WORK 셀로 저장하고
  // halfDayLeave에 어느 쪽이 반차인지 표시만 남긴다. 반환값은 그 직원이 targetDoc에 실제로
  // 있어서 반영됐는지 여부.
  function applyDateSelectionsToDoc(targetDoc, id, selections) {
    const emp = targetDoc.employees.find((e) => e.id === id);
    if (!emp) return false;
    if (!emp.specificOffTypes) emp.specificOffTypes = {};
    if (!targetDoc.schedule[id]) targetDoc.schedule[id] = {};
    Object.entries(selections).forEach(([date, choice]) => {
      if (choice === 'RUNRUN') {
        // 런런(2시간 조기퇴근)은 휴무가 아니라 그날 근무는 그대로 두고 표시만 얹는 것이라,
        // 기존 상태/근무조는 건드리지 않는다.
        const existing = targetDoc.schedule[id][date] || { status: 'WORK', source: 'AUTO' };
        targetDoc.schedule[id][date] = Object.assign({}, existing, { runrun: true });
      } else if (FULL_OFF_TYPES.includes(choice)) {
        if (!emp.specificOff.includes(date)) emp.specificOff.push(date);
        emp.specificOffTypes[date] = choice;
        if (targetDoc.schedule[id][date] && targetDoc.schedule[id][date].source === 'MANUAL') {
          delete targetDoc.schedule[id][date];
        }
      } else {
        const workShift = choice === 'HALF_MORNING' ? 'AFTERNOON' : choice === 'HALF_AFTERNOON' ? 'MORNING' : choice;
        const halfDayLeave = choice === 'HALF_MORNING' ? 'MORNING' : choice === 'HALF_AFTERNOON' ? 'AFTERNOON' : null;
        targetDoc.schedule[id][date] = { status: 'WORK', source: 'MANUAL', shift: workShift, halfDayLeave };
        emp.specificOff = emp.specificOff.filter((d) => d !== date);
        if (emp.specificOffTypes) delete emp.specificOffTypes[date];
      }
    });
    emp.specificOff.sort();
    return true;
  }

  // 이미 만들어져 있는 미래 달 문서는 새 직원이 생겨도 자동으로 반영되지 않는다(각 달 문서는
  // 처음 만들어질 때 딱 한 번만 그 시점의 직원 목록을 복사해오기 때문) — 이번 달에서 직원을
  // 추가하면, 이미 존재하는 이후 달 문서들에도 같은 직원을 곧바로 끼워 넣어 계속 손으로
  // 맞춰줄 필요가 없게 한다(사장님 지시: "자동으로 반영되게 해줘").
  async function propagateNewEmployeeToFutureMonths(newEmp, id) {
    const key = Model.monthKey(doc.month.year, doc.month.month);
    const index = await Storage.loadIndex(state.store);
    const futureKeys = index.filter((e) => e.key > key).map((e) => e.key);
    const idNum = Number(id.replace('emp', '')) || 0;
    for (const fk of futureKeys) {
      const [fy, fm] = fk.split('-').map(Number);
      const futureDoc = await Storage.loadMonth(state.store, fy, fm);
      if (!futureDoc || futureDoc.employees.some((e) => e.id === id)) continue;
      futureDoc.employees.push({
        id,
        name: newEmp.name,
        recurringOff: [...newEmp.recurringOff],
        specificOff: [],
        specificOffTypes: {},
        shiftPreference: newEmp.shiftPreference,
        edgeShiftPreference: newEmp.edgeShiftPreference,
        corner: newEmp.corner,
        corners: [...newEmp.corners]
      });
      if (!futureDoc.meta || futureDoc.meta.nextEmployeeId <= idNum) {
        futureDoc.meta = futureDoc.meta || {};
        futureDoc.meta.nextEmployeeId = idNum + 1;
      }
      await Storage.saveMonth(state.store, futureDoc);
    }
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
      Render.renderCalendarScreen(contentEl, doc, calendarHandlers, state.calendarView);
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
    async onSetHolidayChoice(empId, date, choice) {
      const emp = doc.employees.find((e) => e.id === empId);
      if (!emp) return;
      if (!emp.holidayChoices) emp.holidayChoices = {};
      if (choice) emp.holidayChoices[date] = choice;
      else delete emp.holidayChoices[date];
      await save();
      renderContent();
    },
    async onAddEmployee() {
      const id = `emp${doc.meta.nextEmployeeId++}`;
      const newEmp = Model.createEmployee(id, `직원${doc.employees.length + 1}`);
      doc.employees.unshift(newEmp);
      await save();
      await propagateNewEmployeeToFutureMonths(newEmp, id);
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
    async onAddSpecificOff(id, date, leaveType) {
      const emp = doc.employees.find((e) => e.id === id);
      if (!emp) return;
      if (!emp.specificOff.includes(date)) {
        emp.specificOff.push(date);
        emp.specificOff.sort();
      }
      if (!emp.specificOffTypes) emp.specificOffTypes = {};
      emp.specificOffTypes[date] = leaveType || 'PERSONAL';
      await save();
      renderContent();
    },
    async onAddSpecificOffRange(id, startDate, endDate, leaveType) {
      const emp = doc.employees.find((e) => e.id === id);
      if (!emp) return;
      if (!emp.specificOffTypes) emp.specificOffTypes = {};
      const [sy, sm, sd] = startDate.split('-').map(Number);
      const [ey, em, ed] = endDate.split('-').map(Number);
      const cur = new Date(sy, sm - 1, sd);
      const end = new Date(ey, em - 1, ed);
      while (cur <= end) {
        const dateStr = Model.dateISO(cur.getFullYear(), cur.getMonth() + 1, cur.getDate());
        if (!emp.specificOff.includes(dateStr)) {
          emp.specificOff.push(dateStr);
        }
        emp.specificOffTypes[dateStr] = leaveType || 'PERSONAL';
        cur.setDate(cur.getDate() + 1);
      }
      emp.specificOff.sort();
      await save();
      renderContent();
    },
    // 달력에서 고른 날짜가 지금 보고 있는 달이 아니라 다음 달 등 다른 달일 수도 있다(사장님
    // 지시: "다음달 것도 미리 추가하고 싶을 수가 있잖아... 그건 다음달 거에 자동 반영되는거야")
    // — 날짜별로 그 날짜가 속한 달의 문서를 찾아 각각 반영한다. 지금 보는 달은 이미 메모리에
    // 있는 doc/save()를 그대로 쓰고, 다른 달은 그 달 문서를 불러와(없으면 미래 달만 새로
    // 만들어) 저장한다.
    async onApplyDateSelections(id, selections) {
      const currentKey = Model.monthKey(doc.month.year, doc.month.month);
      const selectionsByMonth = {};
      Object.entries(selections).forEach(([date, choice]) => {
        const [y, m] = date.split('-').map(Number);
        const key = Model.monthKey(y, m);
        if (!selectionsByMonth[key]) selectionsByMonth[key] = {};
        selectionsByMonth[key][date] = choice;
      });

      for (const [key, sel] of Object.entries(selectionsByMonth)) {
        if (key === currentKey) {
          applyDateSelectionsToDoc(doc, id, sel);
          await save();
        } else {
          const [y, m] = key.split('-').map(Number);
          const targetDoc = key > currentKey
            ? await Storage.loadOrCreateMonth(state.store, y, m)
            : await Storage.loadMonth(state.store, y, m);
          if (!targetDoc) continue;
          if (applyDateSelectionsToDoc(targetDoc, id, sel)) {
            await Storage.saveMonth(state.store, targetDoc);
          }
        }
      }
      renderContent();
    },
    async onRemoveSpecificOff(id, date) {
      const emp = doc.employees.find((e) => e.id === id);
      if (!emp) return;
      emp.specificOff = emp.specificOff.filter((d) => d !== date);
      if (emp.specificOffTypes) delete emp.specificOffTypes[date];
      await save();
      renderContent();
    },
    async onClearSpecificOff(id) {
      const emp = doc.employees.find((e) => e.id === id);
      if (!emp) return;
      emp.specificOff = [];
      emp.specificOffTypes = {};
      await save();
      renderContent();
    },
    async onUpdateShiftPreference(id, value) {
      const emp = doc.employees.find((e) => e.id === id);
      if (!emp) return;
      emp.shiftPreference = value;
      await save();
    },
    async onUpdateEdgeShiftPreference(id, value) {
      const emp = doc.employees.find((e) => e.id === id);
      if (!emp) return;
      emp.edgeShiftPreference = value;
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
    async onUpdateDeptRule(dept, field, value) {
      if (!doc.rules.deptRules) doc.rules.deptRules = {};
      if (!doc.rules.deptRules[dept]) doc.rules.deptRules[dept] = {};
      doc.rules.deptRules[dept][field] = value;
      await save();
      renderContent();
    },
    async onUpdateTargetOffDays(targetOffDays) {
      doc.rules.targetOffDays = targetOffDays;
      const n = doc.employees.length;
      const days = Model.daysInMonth(state.year, state.month);
      if (n > 0 && days > 0) {
        const req = Math.round(n - (targetOffDays * n) / days);
        doc.rules.minStaffDefault = Math.max(0, Math.min(n, req));
      }
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
      const previousMonthDoc = await loadPreviousMonthDoc();
      Scheduler.generateSchedule(doc, previousMonthDoc);
      await save();
      state.screen = 'calendar';
      Render.renderNav(navEl, state, navHandlers);
      renderContent();
    }
  };

  const calendarHandlers = {
    onToggleCalendarView(view) {
      state.calendarView = view;
      renderContent();
    },
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
      const previousMonthDoc = await loadPreviousMonthDoc();
      Scheduler.generateSchedule(doc, previousMonthDoc);
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
      const previousMonthDoc = await loadPreviousMonthDoc();
      Scheduler.generateSchedule(doc, previousMonthDoc);
      await save();
      renderContent();
    }
  };

  return { init };
})();

document.addEventListener('DOMContentLoaded', Hyumu.App.init);
