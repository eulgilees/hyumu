window.Hyumu = window.Hyumu || {};

Hyumu.Model = (function () {
  const WEEKDAY_LABELS = ['일', '월', '화', '수', '목', '금', '토'];

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function daysInMonth(year, month) {
    return new Date(year, month, 0).getDate();
  }

  function dateISO(year, month, day) {
    return `${year}-${pad2(month)}-${pad2(day)}`;
  }

  function weekdayOf(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(y, m - 1, d).getDay();
  }

  function isWeekend(dateStr) {
    const wd = weekdayOf(dateStr);
    return wd === 0 || wd === 6;
  }

  function allDatesOfMonth(year, month) {
    const n = daysInMonth(year, month);
    const arr = [];
    for (let d = 1; d <= n; d++) arr.push(dateISO(year, month, d));
    return arr;
  }

  function monthKey(year, month) {
    return `${year}-${pad2(month)}`;
  }

  function createEmployee(id, name) {
    return { id, name, recurringOff: [], specificOff: [], shiftPreference: 'ANY' };
  }

  function defaultRules() {
    return {
      minStaffDefault: 1,
      minStaffByWeekday: {},
      minStaffByDate: {},
      maxConsecutiveWorkDays: 5,
      minRestPerWeekWindow: false,
      minMorningStaff: 0,
      minAfternoonStaff: 0
    };
  }

  const SHIFT_LABELS = { MORNING: '오전', AFTERNOON: '오후' };

  function createMonthDoc(year, month) {
    return {
      version: 1,
      month: { year, month },
      employees: [],
      rules: defaultRules(),
      schedule: {},
      conflicts: [],
      meta: { nextEmployeeId: 1 }
    };
  }

  function isBaseOff(employee, dateStr) {
    if (employee.specificOff.includes(dateStr)) return true;
    return employee.recurringOff.includes(weekdayOf(dateStr));
  }

  function minStaffRequired(rules, dateStr) {
    if (rules.minStaffByDate && rules.minStaffByDate[dateStr] != null) {
      return rules.minStaffByDate[dateStr];
    }
    const wd = weekdayOf(dateStr);
    if (rules.minStaffByWeekday && rules.minStaffByWeekday[wd] != null) {
      return rules.minStaffByWeekday[wd];
    }
    return rules.minStaffDefault;
  }

  return {
    WEEKDAY_LABELS,
    SHIFT_LABELS,
    pad2,
    daysInMonth,
    dateISO,
    weekdayOf,
    isWeekend,
    allDatesOfMonth,
    monthKey,
    createEmployee,
    defaultRules,
    createMonthDoc,
    isBaseOff,
    minStaffRequired
  };
})();
