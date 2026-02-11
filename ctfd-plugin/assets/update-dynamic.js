// Ensure CTFd._internal.challenge exists
if (typeof CTFd !== 'undefined' && CTFd._internal && !CTFd._internal.challenge) {
  CTFd._internal.challenge = {};
}

CTFd._internal.challenge.data = undefined;
CTFd._internal.challenge.preRender = function () {};
CTFd._internal.challenge.render = null;
CTFd._internal.challenge.postRender = function () {
  var $ = CTFd.lib.$;

  function applyPrefixVisibility($select) {
    if (!$select || !$select.length) return;
    var $group = $select.closest(".form-group").next(".prefix-group-conditional");
    var $input = $group.find('input[name="prefix"]');
    if ($group.length === 0) return;
    if ($select.val() === "http") {
      $group.show();
      $input.prop("required", true);
    } else {
      $group.hide();
      $input.prop("required", false);
    }
  }

  // Apply prefix visibility based on current connection type value
  console.log("postRender called (dynamic)");
  $(document).find("select[name=\"connection_type\"]").each(function () {
    console.log("Connection type value:", $(this).val());
    applyPrefixVisibility($(this));
  });

  $(document).off("change.prefixConditional", "select[name=\"connection_type\"]");
  $(document).on("change.prefixConditional", "select[name=\"connection_type\"]", function () {
    applyPrefixVisibility($(this));
  });
};
CTFd._internal.challenge.submit = function () { return Promise.resolve(); };
